// The shared setup-step block: the steps in plain words, and what the person can do when one fails.
export const setupStep = {
  "setupStep.status.waiting": "Waiting",
  "setupStep.status.running": "Working…",
  "setupStep.status.retrying": "Tried {n} times. Trying again…",
  "setupStep.status.done": "Done",
  "setupStep.status.failed": "Tried 3 times",
  "setupStep.failedSentence": "{step} did not work.",
  "setupStep.failedStep": "This step",
  "setupStep.tried": "Tried {n} times. Nothing was left half done.",
  "setupStep.fix": "Let Claude fix it",
  "setupStep.fixAgent": "Let {agent} fix it",
  "setupStep.fixing": "Opening a chat…",
  "setupStep.retry": "Try again",
  "setupStep.details": "Details",
} as const;
