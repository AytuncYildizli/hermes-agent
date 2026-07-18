# Whip operator gateway plugin

This bundled plugin is dormant by default. When explicitly enabled, it treats
every authorized owner WhatsApp text DM as a Whip intention after Hermes has
completed platform authorization. It is intended for the dedicated Çor
operator route; disable it when that route should behave as ordinary chat. It
does not handle groups, commands, media, non-owner messages, or other platforms.

The plugin invokes one fixed absolute `whip-operator-do ingress` launcher with
a bounded canonical request on stdin. Message text, provider identifiers, and
capability material are never placed in argv or logs. A handled failure is
returned to the owner as an explicit blocker and never falls through into the
ordinary conversational session.

Immediate `accepted`, `replayed`, and `resumed` replies are yellow process
acknowledgements, not completion claims. Only the later Governor-bound
same-thread final may report mission success.

## Configuration contract

Add the entry below to the private Hermes config before enabling the plugin.
All paths must be absolute. The capability and registry files must be
single-link, same-UID `0600` files beneath `0700` directories; `state_root`
must also be a same-UID `0700` directory outside every target repository.

```yaml
plugins:
  entries:
    whip_operator:
      launcher: /absolute/path/to/whip/scripts/whip-operator-do
      capability_file: /absolute/private/whip/ingress-capability.json
      target_registry: /absolute/private/whip/target-registry.json
      state_root: /absolute/private/whip/state
      timeout_seconds: 30
      target_hint: null
```

`target_hint` may instead be one exact allowlisted `Org/repo` or registry alias.
With `null`, the registry must contain exactly one default target. The registry
also binds each checkout to its WhatsApp bridge port and private
`bridge-auth-token.v1` path. Whip validates the registry digest and every path;
the plugin does not discover repositories. Whip first honors an authenticated
configured hint, then exact allowlisted repository/alias tokens in the signed
message body, and uses the default only when the body contains no target token.
An unknown `repo:Org/repo` or GitHub URL fails closed rather than falling back.

The ingress capability is distinct from the bridge bearer. It binds the owner
WhatsApp chat/user aliases and signs the canonical envelope shared with Whip.
Provision it through an operator-only path; do not commit it, paste it into
config, or expose it through environment variables.

## Activation and rollback

After current-head review and an explicit runtime gate:

```sh
hermes plugins enable whip_operator
hermes gateway restart
hermes gateway status
```

To stop admitting new missions while preserving all durable Whip state:

```sh
hermes plugins disable whip_operator
hermes gateway restart
hermes gateway status
```

Do not delete origin, launch, receipt, or effect journals to retry a mission.
Exact merge approval and production authority remain Governor-gated in Whip.
