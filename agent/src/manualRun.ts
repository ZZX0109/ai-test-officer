import { runVisualGrayTest } from "./testRunner.js";

const appUrl = process.env.APP_URL ?? "http://localhost:6173";
runVisualGrayTest({
  appUrl,
  permissionProfile: {
    observe: true,
    browserControl: true,
    workspaceControl: false,
    ideTerminalControl: false,
    systemControl: false
  }
})
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
