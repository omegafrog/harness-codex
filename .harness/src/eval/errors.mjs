export class EvalInconclusiveError extends Error {
  constructor(reason, message, details = {}) {
    super(message || reason);
    this.name = "EvalInconclusiveError";
    this.reason = reason;
    this.details = details;
  }
}

export class EvalPolicyViolationError extends Error {
  constructor(reason, message, details = {}) {
    super(message || reason);
    this.name = "EvalPolicyViolationError";
    this.reason = reason;
    this.details = details;
  }
}

export class ManifestValidationError extends EvalInconclusiveError {
  constructor(message, details = {}) {
    super("invalid_case_manifest", message, details);
    this.name = "ManifestValidationError";
  }
}
