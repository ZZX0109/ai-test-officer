import path from "node:path";
import { evaluateBenchmarkFromDisk } from "./benchmark.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();

evaluateBenchmarkFromDisk(rootDir)
  .then((evaluation) => console.log(JSON.stringify(evaluation, null, 2)))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
