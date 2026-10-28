# Hermes memory provider: `hive`

Connects a Hermes instance to a Hive service. **M0 stub:** only the `hive_status` tool.
Recall, turn sync and the fact tools land in M2.

## Install (any machine running Hermes)

```bash
# 1. make the plugin visible to Hermes (directory name = provider name)
ln -s ~/dev/hive/plugins/hive ~/.hermes/plugins/hive

# 2. give it the URL and a token minted by the hive (scripts/setup.sh or mint-token)
#    in ~/.hermes/.env:
HIVE_URL=http://<hive-host>:8800
HIVE_TOKEN=hive_...

# 3. activate it (only one external memory provider can be active)
hermes config set memory.provider hive     # or: hermes memory setup
hermes memory status
```

Activating it replaces any other external provider you have on. Built-in MEMORY.md/USER.md keep working.

## Tests

```bash
~/.hermes/hermes-agent/venv/bin/python -m pytest plugins/hive/tests -q
```
