import { MiGPT } from "../src";
// @ts-ignore
import config from "../.migpt.js";

async function main() {
  const client = new MiGPT("legacy", config);
  await client.start();
}

main();
