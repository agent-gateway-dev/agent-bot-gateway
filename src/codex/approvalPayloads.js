const DISCORD_COMPONENT_TYPE_ACTION_ROW = 1;
const DISCORD_COMPONENT_TYPE_BUTTON = 2;
const DISCORD_BUTTON_STYLE_SECONDARY = 2;
const DISCORD_BUTTON_STYLE_SUCCESS = 3;
const DISCORD_BUTTON_STYLE_DANGER = 4;

export function buildResponseForServerRequest(method, params, decision) {
  if (method === "item/tool/requestUserInput") {
    return buildToolRequestUserInputResponse(params, decision);
  }
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    return { decision: mapReviewDecision(decision) };
  }
  return { decision };
}

function mapReviewDecision(decision) {
  if (decision === "accept") {
    return "approved";
  }
  if (decision === "cancel") {
    return "abort";
  }
  return "denied";
}

function buildToolRequestUserInputResponse(params, decision) {
  const answers = {};
  const questions = Array.isArray(params?.questions) ? params.questions : [];
  for (const question of questions) {
    if (typeof question?.id !== "string" || !question.id) {
      continue;
    }
    const answer = pickToolRequestAnswer(question, decision);
    answers[question.id] = { answers: [answer] };
  }
  return { answers };
}

function pickToolRequestAnswer(question, decision) {
  const options = Array.isArray(question?.options) ? question.options : [];
  if (options.length > 0) {
    const labels = options
      .map((option) => (typeof option?.label === "string" ? option.label.trim() : ""))
      .filter((label) => label.length > 0);
    const matched = findDecisionOptionLabel(labels, decision);
    if (matched) {
      return matched;
    }
    if (labels.length > 0) {
      return labels[0];
    }
  }

  if (decision === "accept") {
    return "accept";
  }
  if (decision === "cancel") {
    return "cancel";
  }
  return "decline";
}

function findDecisionOptionLabel(labels, decision) {
  const normalized = labels.map((label) => ({ original: label, lower: label.toLowerCase() }));
  const needlesByDecision = {
    accept: ["accept", "approve", "allow", "yes", "continue", "proceed", "ok"],
    decline: ["decline", "reject", "deny", "disallow", "no"],
    cancel: ["cancel", "abort", "stop", "dismiss"]
  };
  const needles = needlesByDecision[decision] ?? [];

  for (const needle of needles) {
    const exact = normalized.find((entry) => entry.lower === needle);
    if (exact) {
      return exact.original;
    }
  }
  for (const needle of needles) {
    const partial = normalized.find((entry) => entry.lower.includes(needle));
    if (partial) {
      return partial.original;
    }
  }

  return null;
}

export function describeToolRequestUserInput(params) {
  const lines = [];
  const questions = Array.isArray(params?.questions) ? params.questions : [];
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index];
    const header = typeof question?.header === "string" && question.header ? question.header : `q${index + 1}`;
    const prompt =
      typeof question?.question === "string" && question.question ? question.question : "(no prompt text)";
    lines.push(`question ${index + 1} (${header}): ${prompt}`);
    if (Array.isArray(question?.options) && question.options.length > 0) {
      const optionLabels = question.options
        .map((option) => (typeof option?.label === "string" ? option.label.trim() : ""))
        .filter((label) => label.length > 0);
      if (optionLabels.length > 0) {
        lines.push(`options: ${optionLabels.map((label) => `\`${label}\``).join(", ")}`);
      }
    }
  }
  return lines;
}

export function buildApprovalActionRows(token, prefix, options = {}) {
  const disabled = options.disabled === true;
  const selectedDecision = options.selectedDecision ?? null;
  return [
    {
      type: DISCORD_COMPONENT_TYPE_ACTION_ROW,
      components: [
        {
          type: DISCORD_COMPONENT_TYPE_BUTTON,
          custom_id: `${prefix}${token}:accept`,
          label: selectedDecision === "accept" ? "Approved" : "Approve",
          style: DISCORD_BUTTON_STYLE_SUCCESS,
          disabled
        },
        {
          type: DISCORD_COMPONENT_TYPE_BUTTON,
          custom_id: `${prefix}${token}:decline`,
          label: selectedDecision === "decline" ? "Declined" : "Decline",
          style: DISCORD_BUTTON_STYLE_DANGER,
          disabled
        },
        {
          type: DISCORD_COMPONENT_TYPE_BUTTON,
          custom_id: `${prefix}${token}:cancel`,
          label: selectedDecision === "cancel" ? "Canceled" : "Cancel",
          style: DISCORD_BUTTON_STYLE_SECONDARY,
          disabled
        }
      ]
    }
  ];
}

export function parseApprovalButtonCustomId(customId, prefix) {
  if (typeof customId !== "string" || !customId.startsWith(prefix)) {
    return null;
  }
  const payload = customId.slice(prefix.length);
  const [token, decision] = payload.split(":");
  if (!token || !isApprovalDecision(decision)) {
    return null;
  }
  return { token, decision };
}

function isApprovalDecision(decision) {
  return decision === "accept" || decision === "decline" || decision === "cancel";
}
