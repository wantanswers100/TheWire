// Tests never depend on this installation's private settings
// (.wire-state/local.json, .wire-state/project-entities.json).
process.env["WIRE_APPROVER"] = "owner";
process.env["WIRE_BRIEFING_PATH"] = "";
