// Adapted from grph-deployment/frontend/src/components/DeploymentSteps.tsx.
// Keep the same ordered setup, back navigation, review and explicit finish model
// without requiring the controller's React application on participant machines.
export const stages = [
  "Configuration",
  "Network & identity",
  "Checkpoint & install",
  "Services & endpoints",
];
export const stageIds = ["configuration", "chain", "runtime", "monitor"];
export function deploymentSteps(current, completed = []) {
  return (
    '<nav aria-label="Deployment steps"><ol class="deployment-steps">' +
    stages
      .map(
        (label, index) =>
          '<li><button data-step="' +
          stageIds[index] +
          '" ' +
          (index === current ? 'aria-current="step"' : "") +
          "><span>" +
          (completed.includes(index) ? "✓" : index + 1) +
          "</span>" +
          label +
          "</button></li>",
      )
      .join("") +
    "</ol></nav>"
  );
}
