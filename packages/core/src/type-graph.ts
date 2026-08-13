import type { TupleStore } from "./store-interface.ts";
import type { RelationConfig } from "./types.ts";

/**
 * The subject a reachability question is asked about: a bare type
 * (`user`), which stands equally for its typed wildcard (`user:*`),
 * or a userset ref (`team#member`).
 */
export interface SubjectRef {
  type: string;
  /** Set for a userset ref: `team#member`. */
  relation?: string;
}

/**
 * Answers, from the authorization model alone, whether a subject of
 * a given type could *ever* hold `objectType#relation` — at any
 * depth, for any data.
 *
 * This is tsfga's stand-in for upstream's type graph.
 * `LocalChecker.ResolveCheck` calls
 * `typesys.PathExists(user, relation, objectType)` at **every**
 * node and answers `Allowed:false` before resolving the rewrite,
 * so a subtree the subject's type cannot reach is never walked.
 * tsfga has no whole-model view — `TupleStore` hands out one
 * `RelationConfig` at a time and must not grow a "list every
 * config" method for this — so the same question is answered
 * *backwards and lazily* instead: from the node, collect the
 * subject refs that can terminate there.
 *
 * Ref: https://github.com/openfga/openfga/blob/560d5d3dd46b5adda9ecfb29efeb4f4f70c96327/internal/graph/check.go#L455
 * Ref: https://github.com/openfga/openfga/blob/560d5d3dd46b5adda9ecfb29efeb4f4f70c96327/pkg/typesystem/typesystem.go#L708
 */
export interface Reachability {
  /**
   * Can a subject of this ref reach `objectType#relation`?
   *
   * Answers `true` whenever the model does not settle the
   * question — a relation the walk could not read leaves the
   * answer open rather than pruning. Pruning is an optimisation
   * that must never *create* a denial the walk did not prove.
   */
  reaches(
    subject: SubjectRef,
    objectType: string,
    relation: string,
  ): Promise<boolean>;

  /**
   * The same answer when a walk has already settled this node, and
   * `undefined` when none has — no store read, no microtask.
   *
   * It exists so the prune is free in the case that dominates: a
   * scope resolves the same handful of `objectType#relation` nodes
   * over and over, once per object, and one walk settles a node
   * together with everything it reaches. Only the genuinely cold
   * ask pays, which keeps the prune from reordering the store reads
   * around it — and the order of those reads decides which branch
   * of a union wins a race, so it is observable.
   */
  settledReaches(
    subject: SubjectRef,
    objectType: string,
    relation: string,
  ): boolean | undefined;
}

/**
 * The subject refs that can terminate at one node.
 *
 * `types` holds bare and wildcard restrictions together. Upstream
 * retries a subject type with no direct path as its typed wildcard,
 * so the two are effectively OR-ed; folding them into one set gets
 * that retry for free and cannot prune a grant a `user:*` row could
 * have produced.
 *
 * `usersets` is keyed type → relations for the same reason the
 * memos in `check.ts` and `caching-store.ts` are nested: identifier
 * charsets are unrestricted, so a joined `type#relation` key can
 * collide across different refs.
 */
interface Sources {
  readonly types: ReadonlySet<string>;
  readonly usersets: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * The walk could not read part of the model — a relation it does
   * not define, or a store read that failed. The node's own
   * resolution raises for both, and a prune must never convert a
   * refusal into a `false`, so an incomplete node prunes nothing.
   */
  readonly incomplete: boolean;
}

/**
 * One node of the model graph, and the source set a walk settled
 * for it. Node identity is an object rather than a joined string so
 * that sets of nodes need no key encoding.
 */
interface Node {
  readonly objectType: string;
  readonly relation: string;
  sources: Sources | null;
}

/** What one node's expansion accumulates before it settles. */
class Accumulator {
  readonly types = new Set<string>();
  readonly usersets = new Map<string, Set<string>>();
  incomplete = false;

  addUserset(type: string, relation: string): void {
    let relations = this.usersets.get(type);
    if (!relations) {
      relations = new Set();
      this.usersets.set(type, relations);
    }
    relations.add(relation);
  }

  absorb(sources: Sources): void {
    for (const type of sources.types) this.types.add(type);
    for (const [type, relations] of sources.usersets) {
      for (const relation of relations) this.addUserset(type, relation);
    }
    if (sources.incomplete) this.incomplete = true;
  }

  settle(): Sources {
    return {
      types: this.types,
      usersets: this.usersets,
      incomplete: this.incomplete,
    };
  }
}

const NO_SOURCES: Sources = {
  types: new Set(),
  usersets: new Map(),
  incomplete: false,
};

/**
 * What one `visit` hands back: the node's sources, and the nodes
 * whose expansion it had to truncate to get them.
 *
 * `open` is the reason a node can be published at all. A truncated
 * return is an under-approximation, and so is every ancestor of it
 * — until the ancestor that was *itself* the truncation target,
 * whose accumulated set is the whole strongly-connected component
 * and is therefore exact. Removing a node from `open` on the way
 * out is that rule; an empty `open` is permission to publish. It is
 * Tarjan's lowlink written as a set.
 */
interface VisitResult {
  readonly sources: Sources;
  readonly open: ReadonlySet<Node>;
}

const NO_OPEN: ReadonlySet<Node> = new Set();

/**
 * Run tasks with at most `limit` in flight.
 *
 * The walk reads relation configs, so it spends the same budget
 * every other store read on the check path does: `maxBreadth`
 * bounds one node's branches. As with the check itself the bound is
 * per node rather than per call, so nesting compounds — the
 * property `packages/kysely/README.md` sizes pools against.
 */
async function runBounded(
  tasks: readonly (() => Promise<void>)[],
  limit: number,
): Promise<void> {
  if (tasks.length === 0) return;
  if (limit >= tasks.length) {
    await Promise.all(tasks.map((task) => task()));
    return;
  }
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const task = tasks[next];
      next++;
      if (task) await task();
    }
  };
  const workers: Promise<void>[] = [];
  for (let i = 0; i < limit; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
}

export function createReachability(
  store: TupleStore,
  maxBreadth: number,
): Reachability {
  const nodes = new Map<string, Map<string, Node>>();

  function nodeFor(objectType: string, relation: string): Node {
    let byRelation = nodes.get(objectType);
    if (!byRelation) {
      byRelation = new Map();
      nodes.set(objectType, byRelation);
    }
    let node = byRelation.get(relation);
    if (!node) {
      node = { objectType, relation, sources: null };
      byRelation.set(relation, node);
    }
    return node;
  }

  /**
   * A config read that answers "the walk could not see this node"
   * instead of failing.
   *
   * The prune is layered over a resolution that reads the very same
   * configs, so a store failure must reach the caller from *there*
   * — where the union, intersection and exclusion rules decide what
   * to do with it — and not from here. Letting it escape the walk
   * turned "a sibling branch granted, so its error is discarded"
   * into a refusal at the root.
   */
  async function readConfig(
    objectType: string,
    relation: string,
  ): Promise<RelationConfig | null | undefined> {
    try {
      return await store.findRelationConfig(objectType, relation);
    } catch {
      return undefined;
    }
  }

  /**
   * The nodes whose expansion is in flight in the current
   * traversal. A second arrival truncates instead of waiting:
   * waiting would deadlock the moment two mutually reachable nodes
   * were expanded at once, and truncating costs nothing, because
   * the arrival that *is* expanding the node returns its sources up
   * the tree to a common ancestor regardless.
   */
  const expanding = new Set<Node>();

  /**
   * Collect one node's in-edges, then recurse into the nodes those
   * edges come from.
   *
   * `optional` marks the one place a missing config is not a broken
   * model: a tuple-to-userset's computed relation, which upstream
   * accepts as undefined on *some* of the tupleset's types and
   * simply drops those rows (`produceTTUDispatches`) — the same
   * per-row skip `resolveTupleset` already makes.
   */
  async function visit(node: Node, optional: boolean): Promise<VisitResult> {
    if (node.sources) {
      return { sources: node.sources, open: NO_OPEN };
    }
    if (expanding.has(node)) {
      return { sources: NO_SOURCES, open: new Set([node]) };
    }
    expanding.add(node);

    const acc = new Accumulator();
    const open = new Set<Node>();
    const branches: (() => Promise<void>)[] = [];

    const descend = (child: Node, childOptional: boolean) => {
      branches.push(async () => {
        const result = await visit(child, childOptional);
        acc.absorb(result.sources);
        for (const pendingNode of result.open) open.add(pendingNode);
      });
    };

    // A relation node is a source of *itself*. `type#relation`
    // holds `relation` on `type` by definition — upstream answers
    // that in `IsSelfDefining` before the type graph is consulted
    // at all, and `PathExists` for a userset subject walks *from*
    // the node the userset names, so that node is trivially
    // reachable from itself (`typesystem.go:708-729`).
    //
    // Recorded before the config is read, and never conditioned on
    // `directlyAssignable`: the identity holds even where the
    // relation admits no userset at all, measured on v1.18.2 and
    // recorded beside `checkNode`'s identity block. Without it,
    // every rewrite standing between a userset subject and the
    // relation it names — a computed userset, a union arm, an
    // exclusion minuend, a tuple-to-userset — pruned the node to
    // `DENIED` before the identity could fire.
    //
    // This widens the source set, which is the safe direction: the
    // prune must stay wider than the truth. It cannot grant across
    // objects, because the walk is a question about the model's
    // shape and knows no object ids — `checkNode`'s identity still
    // compares `objectId`.
    acc.addUserset(node.objectType, node.relation);

    const config = await readConfig(node.objectType, node.relation);
    if (config === undefined) {
      acc.incomplete = true;
    } else if (config === null) {
      if (!optional) acc.incomplete = true;
    } else {
      // Direct assignment. A userset restriction is both an edge in
      // its own right — a `team#member` subject terminates here —
      // and a reason to recurse, since whoever holds `member` on a
      // `team` reaches this node through it.
      for (const restriction of config.directlyAssignable) {
        if (restriction.relation === undefined) {
          acc.types.add(restriction.type);
          continue;
        }
        acc.addUserset(restriction.type, restriction.relation);
        descend(nodeFor(restriction.type, restriction.relation), false);
      }

      // Rewrites of the same object. The subtrahend of an exclusion
      // is included deliberately: it makes the set wider than the
      // truth — a subject reaching only the subtrahend cannot hold
      // the relation — and wider is the safe direction, because a
      // prune must never delete a grant.
      for (const implied of config.impliedBy ?? []) {
        descend(nodeFor(node.objectType, implied), false);
      }
      if (config.computedUserset !== null) {
        descend(nodeFor(node.objectType, config.computedUserset), false);
      }
      if (config.excludedBy !== null) {
        descend(nodeFor(node.objectType, config.excludedBy), false);
      }

      for (const entry of config.tupleToUserset ?? []) {
        branches.push(() =>
          expandTupleToUserset(
            node.objectType,
            entry.tupleset,
            entry.computedUserset,
            acc,
            open,
          ),
        );
      }

      // An intersection holds only if **every** operand does, so
      // any single operand's sources already over-approximate the
      // whole: a subject that cannot reach one operand cannot hold
      // the relation, whatever the others admit.
      //
      // A `direct` operand is exactly the edges collected above —
      // it runs `checkBase` over this same config, steps 1-5
      // included — so when one is present it alone answers the
      // question and the other operands need not be read. That is
      // not only an economy: the walk reads configs the resolution
      // never asks for, and reading fewer of them keeps the prune
      // closer to invisible.
      //
      // With no `direct` operand there is nothing already collected
      // to stand on, so the rest are folded as a union.
      const operands = config.intersection ?? [];
      const groundedOnDirect = operands.some(
        (operand) => operand.type === "direct",
      );
      for (const operand of groundedOnDirect ? [] : operands) {
        if (operand.type === "computedUserset" && operand.relation) {
          descend(nodeFor(node.objectType, operand.relation), false);
        } else if (
          operand.type === "tupleToUserset" &&
          operand.tupleset !== undefined &&
          operand.computedUserset !== undefined
        ) {
          const { tupleset, computedUserset } = operand;
          branches.push(() =>
            expandTupleToUserset(
              node.objectType,
              tupleset,
              computedUserset,
              acc,
              open,
            ),
          );
        }
      }
    }

    await runBounded(branches, maxBreadth);

    expanding.delete(node);
    open.delete(node);
    const sources = acc.settle();
    // Publishable when nothing below is still unresolved. An
    // incomplete node is never published: it may be incomplete
    // because a store read failed, and pinning that for the rest of
    // the scope would outlive the failure — the rule
    // `caching-store.ts` already applies to a rejected read.
    if (open.size === 0 && !sources.incomplete) {
      node.sources = sources;
    }
    return { sources, open };
  }

  /**
   * A tuple-to-userset contributes no subject ref of its own: what
   * reaches the node is whoever holds `computedUserset` on a type
   * the tupleset relation admits.
   */
  async function expandTupleToUserset(
    objectType: string,
    tupleset: string,
    computedUserset: string,
    acc: Accumulator,
    open: Set<Node>,
  ): Promise<void> {
    const config = await readConfig(objectType, tupleset);
    // The tupleset relation is a relation of *this* object and
    // upstream requires it to be defined; `resolveTupleset` raises
    // for a missing one, so the walk must not prune around it.
    if (config === null || config === undefined) {
      acc.incomplete = true;
      return;
    }
    const types = new Set(config.directlyAssignable.map((r) => r.type));
    await runBounded(
      [...types].map((type) => async () => {
        const result = await visit(nodeFor(type, computedUserset), true);
        acc.absorb(result.sources);
        for (const pendingNode of result.open) open.add(pendingNode);
      }),
      maxBreadth,
    );
  }

  /**
   * Walks run one at a time.
   *
   * `expanding` has to mean "on *this* traversal", and one shared
   * set can only mean that if one traversal is in flight. Overlap it
   * and a second walk starting at a node the first is already
   * expanding truncates *at its own root* — and a root is published
   * unconditionally, so the empty set that truncation returns
   * becomes the node's settled answer and prunes every subject away
   * from it. Serializing is the fix that does not need a wait graph:
   * making a cross-traversal arrival await the other walk instead
   * reintroduces exactly the deadlock the truncation exists to
   * avoid, now between walks.
   *
   * It costs little. A walk is CPU plus config reads the scope's
   * cache is already coalescing, and each queued ask re-checks for a
   * settled answer before starting, so the common case — many nodes
   * asking about the same relation at once — resolves the first and
   * finds the rest already answered.
   */
  let queue: Promise<unknown> = Promise.resolve();

  function sourcesFor(objectType: string, relation: string): Promise<Sources> {
    const node = nodeFor(objectType, relation);
    if (node.sources) return Promise.resolve(node.sources);

    const walk = queue.then(async () => {
      // Another walk may have settled it while this one queued.
      if (node.sources) return node.sources;
      const result = await visit(node, false);
      // The node a walk starts from is publishable even when `open`
      // is not empty: every node the traversal reached was expanded
      // exactly once and returned its sources up the tree, so the
      // root's accumulation is the complete closure whatever was
      // truncated below it.
      if (!result.sources.incomplete) {
        node.sources = result.sources;
      }
      return result.sources;
    });
    queue = walk.catch(() => {});
    return walk;
  }

  function answer(sources: Sources, subject: SubjectRef): boolean {
    if (sources.incomplete) return true;
    if (subject.relation !== undefined) {
      return sources.usersets.get(subject.type)?.has(subject.relation) === true;
    }
    return sources.types.has(subject.type);
  }

  return {
    async reaches(subject, objectType, relation) {
      return answer(await sourcesFor(objectType, relation), subject);
    },

    settledReaches(subject, objectType, relation) {
      const sources = nodes.get(objectType)?.get(relation)?.sources;
      return sources ? answer(sources, subject) : undefined;
    },
  };
}
