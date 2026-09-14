# Rollback

Rollback is a deployment operation for the DSH profile and preset that load
this bundle. Stop DSH, restore the previously saved profile package and lock
files plus the associated bundle and preset configuration, then start DSH and
create a fresh session.

Before restoring, record the active profile and preset configuration so the
change can be reversed if needed. After restoration, verify that the
expected tool catalog is restored and ordinary DSH profiles still start
normally. When reverting to v0.1.0, `codex_expert` should remain available in
the configured preset; it should be absent only when uninstalling the plugin.

For a linked source checkout, preserve a copy of the current checkout first,
then restore the known-good plugin package and its complete build artifacts
together. Restoring only profile manifests will not revert linked source.

The package itself has no migration step and does not alter repository source
files during rollback. Keep a deployment backup that covers the profile
package manifest, lockfile, bundle patch, and user preset files. Exact backup
locations are installation-specific and should be recorded by the operator;
this public document intentionally contains no machine-specific paths.
