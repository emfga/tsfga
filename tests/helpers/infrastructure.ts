import pg from "pg";

async function waitForPostgres(maxRetries = 5): Promise<void> {
  const pool = new pg.Pool({
    host: process.env.POSTGRES_HOST,
    port: Number(process.env.POSTGRES_PORT),
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB,
  });

  let lastError: unknown | null = null;

  for (let i = 0; i < maxRetries; i++) {
    try {
      await pool.query("SELECT 1");
      await pool.end();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  await pool.end();
  throw new Error(
    "PostgreSQL is not reachable. Run 'bun run infra:setup' first.",
    { cause: lastError },
  );
}

async function waitForOpenFGA(maxRetries = 5): Promise<void> {
  const url = process.env.FGA_API_URL;

  let lastError: unknown | null = null;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const resp = await fetch(`${url}/stores`);
      if (resp.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    "OpenFGA is not reachable. Run 'bun run infra:setup' first.",
    { cause: lastError },
  );
}

export async function checkInfrastructure(): Promise<void> {
  await waitForPostgres();
  await waitForOpenFGA();
}
