import { getInput, setFailed, setOutput, setSecret } from "@actions/core";
import { context } from "@actions/github";
import type { PullRequestEvent } from "@octokit/webhooks-types";
import ensureError from "ensure-error";
import { template } from "lodash-es";
import { z } from "zod";
import { backport } from "./backport.js";
import { readAiConfig } from "./config.js";

const run = async () => {
  try {
    const aiConfig = readAiConfig({
      get: (name, options) => getInput(name, options),
    });

    if (aiConfig.enabled) {
      if (aiConfig.apiKey) {
        setSecret(aiConfig.apiKey);
      }

      if (aiConfig.awsAccessKeyId) {
        setSecret(aiConfig.awsAccessKeyId);
      }

      if (aiConfig.awsSecretAccessKey) {
        setSecret(aiConfig.awsSecretAccessKey);
      }

      if (aiConfig.awsSessionToken) {
        setSecret(aiConfig.awsSessionToken);
      }

      if (aiConfig.gcpServiceAccountJson) {
        setSecret(aiConfig.gcpServiceAccountJson);
      }
    }

    const safeTemplateSettings = {
      escape: /($^)/,
      evaluate: /($^)/,
      interpolate: /<%=([\s\S]+?)%>/g,
    };
    const [getBody, getHead, _getLabels, getTitle] = [
      "body_template",
      "head_template",
      "labels_template",
      "title_template",
    ].map((name) => template(getInput(name), safeTemplateSettings));

    const getLabels = ({
      base,
      labels,
    }: Readonly<{ base: string; labels: readonly string[] }>): string[] => {
      const json = _getLabels({ base, labels });
      try {
        return z.array(z.string()).parse(JSON.parse(json));
      } catch (_error: unknown) {
        const error = ensureError(_error);
        throw new Error(`Could not parse labels from invalid JSON: ${json}.`, {
          cause: error,
        });
      }
    };

    const labelPattern = getInput("label_pattern");

    if (!labelPattern.includes("(?<base>")) {
      throw new Error(
        `label_pattern must contain the (?<base> named capture group, got: ${labelPattern}.`,
      );
    }

    const labelRegExp = new RegExp(labelPattern);

    const token = getInput("github_token", { required: true });
    setSecret(token);

    if (context.eventName !== "pull_request") {
      throw new Error(
        `This action must be triggered by the 'pull_request' event, not '${context.eventName}'. Using pull_request_target with fork PRs is a privilege-escalation risk.`,
      );
    }

    if (!context.payload.pull_request) {
      throw new Error(`Unsupported event action: ${context.payload.action}.`);
    }

    const payload = context.payload as PullRequestEvent;

    if (payload.action !== "closed" && payload.action !== "labeled") {
      throw new Error(
        `Unsupported pull request event action: ${payload.action}.`,
      );
    }

    const result = await backport({
      aiConfig,
      getBody,
      getHead,
      getLabels,
      getTitle,
      labelRegExp,
      payload,
      token,
    });
    setOutput(
      "created_pull_requests",
      JSON.stringify(result.createdPullRequests),
    );
    const failures = result.destinations.filter(
      (
        destination,
      ): destination is Extract<
        (typeof result.destinations)[number],
        { status: "failed" }
      > => destination.status === "failed",
    );

    if (failures.length > 0) {
      setFailed(
        new Error(
          failures.map(({ base, reason }) => `${base}: ${reason}`).join("\n"),
        ),
      );
    }
  } catch (_error: unknown) {
    const error = ensureError(_error);
    setFailed(error);
  }
};

void run();
