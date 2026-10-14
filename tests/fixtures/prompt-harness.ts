import { promptYesNo } from "../../src/cli/prompt.js";
const ok = await promptYesNo("Harness?");
console.log(ok ? "RESULT=APPROVED" : "RESULT=REFUSED");
