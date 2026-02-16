model
  schema 1.1

type user

type document
  relations
    define viewer: [user, user with temporal_access]

condition temporal_access(grant_time: timestamp, grant_duration: duration, current_time: timestamp) {
   current_time < grant_time + grant_duration
}
