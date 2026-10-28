import hashlib
import importlib.metadata
import json
from pathlib import Path
import re
import socket
from unittest.mock import patch
from sentry_relay.processing import convert_datascrubbing_config, pii_strip_event

source = Path("src/lib/telemetry/transaction-execution-diagnostics.ts").read_bytes()
assert hashlib.sha256(source).hexdigest() == "a9b263077454e7ec063c8800c2f252b65e26d40ebe1eb389f77a81208212f2d5"
fields = [
    ("authObservation", "executionObservation", "AUTH_OBSERVATIONS"),
    ("authArgPresence", "executionArguments", "AUTH_ARG_PRESENCE"),
    ("authLayout", "executionLayout", "AUTH_LAYOUTS"),
    ("accountAuthCode", "accountCodeFamily", "ACCOUNT_AUTH_CODES"),
]
settings = {"scrubData": True, "scrubDefaults": True, "scrubIpAddresses": False, "excludeFields": [], "sensitiveFields": []}
results = []
def forbid_network(*args, **kwargs):
    raise AssertionError("Synthetic engine invocation must remain offline")
with patch.object(socket, "socket", forbid_network), patch.object(socket, "create_connection", forbid_network):
    config = convert_datascrubbing_config(settings)
    for old, new, constant in fields:
        members = re.findall(r"'([^']+)'", source.decode().split("export const " + constant + " = [", 1)[1].split("] as const", 1)[0])
        assert members and len(set(members)) == len(members)
        for member in members:
            event = {"message": "synthetic diagnostic proof", "contexts": {"walletDiagnostics": {old: member, new: member}}}
            result = pii_strip_event(config, event)
            values = result["contexts"]["walletDiagnostics"]
            assert values[old] == "[Filtered]", (old, member, values)
            assert values[new] == member, (new, member, values)
            remarks = result.get("_meta", {}).get("contexts", {}).get("walletDiagnostics", {}).get(old, {}).get("", {}).get("rem", [])
            assert any(row[0] == "@password:filter" and row[1] == "s" for row in remarks)
            results.append({"old_key": old, "new_key": new, "public_enum": member, "old_filtered": True, "new_preserved": True})
    assert len(results) == 15
    for stage in ["declared_network", "genesis_header"]:
        result = pii_strip_event(config, {"contexts": {"walletDiagnostics": {"backupNetworkFailureStage": stage}}})
        assert result["contexts"]["walletDiagnostics"]["backupNetworkFailureStage"] == stage
        results.append({"backup_stage_preserved": stage})
    result = pii_strip_event(config, {"contexts": {"proof": {"password": "synthetic_canary", "access_token": "synthetic_canary", "ordinary": "synthetic_canary", "neutral": "synthetic_auth_marker"}}})["contexts"]["proof"]
    assert result["password"] == "[Filtered]"
    assert result["access_token"] == "[Filtered]"
    assert result["neutral"] == "[Filtered]"
    assert result["ordinary"] == "synthetic_canary"
    results.append({"sensitive_key_scrubbed": True, "token_key_scrubbed": True, "sensitive_value_scrubbed": True, "ordinary_preserved": True})
report = {"synthetic_only": True, "offline": True, "reference_engine": importlib.metadata.version("sentry-relay"), "vocabulary_sha256": hashlib.sha256(source).hexdigest(), "cases": len(results), "results": results, "limitations": ["Reference engine does not establish SaaS server version", "No real event, hidden value or credential was supplied or reconstructed", "Client privacy and actual wire tests remain separate gates"]}
Path("execution-scrubber-proof.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps({"cases":len(results),"public_values":15,"old_filtered":15,"new_preserved":15,"privacy_canaries":True,"offline":True}))
