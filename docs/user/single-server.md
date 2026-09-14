# One Server per Data Directory

Only one T3 Code server may run against a given data directory. Two servers sharing one directory
both open the same database and both write the same settings file, so they overwrite each other:
threads disappear, and settings changes refuse to stick.

When you start a server whose data directory is already in use, it refuses to start and prints a
message naming the server that is holding it:

```
Another T3 Code server is already using this data directory.

  data directory: /home/you/.t3/userdata
  held by:        pid 12345, listening on port 3000
  since:          2026-01-01T12:00:00.000Z

Two servers sharing one data directory overwrite each other's state.sqlite
and settings.json. Stop the running server, or start this one with a
different --base-dir.

If that process is gone, remove /home/you/.t3/userdata/server.lock and start again.
```

## If a Server Is Really Running

Stop it first, then start yours. If you need both, give the new server its own data directory with
`--base-dir`.

## If the Named Process Is Gone

A server that was killed or crashed leaves its lock file behind. If the process named in the
message no longer exists, remove the lock file named in the message and start again:

```sh
rm /home/you/.t3/userdata/server.lock
```

A pid that has since been reused by an unrelated process also refuses to start. That is deliberate:
removing a lock that might belong to a running server is what the lock exists to prevent, and the
message tells you when removal is the recovery.

## If the Lock Could Not Be Read

Occasionally a server is killed halfway through writing its lock, leaving a file that cannot be
read. The server waits briefly in case another server is starting at that moment, then refuses with
a message saying the lock could not be claimed. If no server is starting or running, remove the
lock file named in the message and start again.
