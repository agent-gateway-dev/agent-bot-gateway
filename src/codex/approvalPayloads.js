import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

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
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${prefix}${token}:accept`)
      .setLabel(selectedDecision === "accept" ? "Approved" : "Approve")
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`${prefix}${token}:decline`)
      .setLabel(selectedDecision === "decline" ? "Declined" : "Decline")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`${prefix}${token}:cancel`)
      .setLabel(selectedDecision === "cancel" ? "Canceled" : "Cancel")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled)
  );
  return [row];
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
