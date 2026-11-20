import type { PaseoProviderActions } from "@getpaseo/client";

// Authenticated Paseo 0.17.0-beta.1 SDK capture, 2026-11-20; catalog metadata omitted.
export const liveSnapshot = {
  "generatedAt": "2026-11-20T18:30:46.590Z",
  "entries": [
    {
      "provider": "claude",
      "status": "ready",
      "enabled": true,
      "label": "Claude"
    },
    {
      "provider": "codex",
      "status": "ready",
      "enabled": true,
      "label": "Codex"
    },
    {
      "provider": "copilot",
      "status": "unavailable",
      "enabled": false,
      "label": "Copilot"
    },
    {
      "provider": "opencode",
      "status": "ready",
      "enabled": true,
      "label": "OpenCode"
    },
    {
      "provider": "pi",
      "status": "unavailable",
      "enabled": false,
      "label": "Pi"
    },
    {
      "provider": "omp",
      "status": "ready",
      "enabled": true,
      "label": "Oh My Pi"
    },
    {
      "provider": "antigravity",
      "status": "unavailable",
      "enabled": false,
      "label": "Antigravity"
    },
    {
      "provider": "muse",
      "status": "unavailable",
      "enabled": false,
      "label": "Muse Code"
    },
    {
      "provider": "qwen-code",
      "status": "unavailable",
      "enabled": false,
      "label": "Qwen Code"
    },
    {
      "provider": "glm-acp-agent",
      "status": "ready",
      "enabled": true,
      "label": "GLM Agent"
    },
    {
      "provider": "hermes",
      "status": "ready",
      "enabled": true,
      "label": "Hermes"
    }
  ],
  "snapshotHash": "39EAEy0VTRJCES31-WKAs-uQwuFcEsICX26Z1lrNq5M",
  "fetchedAt": {
    "claude": "2026-11-20T18:27:49.303Z",
    "codex": "2026-11-20T18:27:49.640Z",
    "opencode": "2026-11-20T18:27:53.151Z",
    "omp": "2026-11-20T18:27:49.888Z",
    "glm-acp-agent": "2026-11-20T18:27:49.457Z",
    "hermes": "2026-11-20T18:27:52.856Z"
  },

  "requestId": "c51f5306-4462-4529-a8cb-eed1c940b171"
} satisfies Awaited<ReturnType<PaseoProviderActions["waitForReady"]>>;

export const claudeControls = {
  "draft": {
    "provider": "claude/claude-opus-5-5",
    "cwd": "/repo",
    "providerOptions": {
      "extraArgs": {
        "tools": "Read,Glob,Grep"
      },
      "allowedTools": [
        "Read",
        "Glob",
        "Grep"
      ],
      "disallowedTools": [
        "mcp__*"
      ]
    }
  },
  "result": {
    "provider": "claude",
    "controls": [
      {
        "type": "toggle",
        "key": "fast_mode",
        "label": "Fast",
        "description": "Lower latency responses at higher token cost",
        "tooltip": "Toggle fast mode",
        "icon": "zap"
      },
      {
        "type": "toggle",
        "key": "ultracode",
        "label": "Ultracode",
        "description": "Let Claude plan workflows for substantive tasks",
        "icon": "Workflow"
      }
    ],
    "options": {
      "extraArgs": {
        "tools": "Read,Glob,Grep"
      },
      "allowedTools": [
        "Read",
        "Glob",
        "Grep"
      ],
      "disallowedTools": [
        "mcp__*"
      ]
    },
    "error": null,
    "fetchedAt": "2026-11-20T18:30:46.603Z",
    "requestId": "27d2e360-3ca3-4772-b937-0d8c2655a541"
  }
} satisfies { draft: Parameters<PaseoProviderActions["listControls"]>[0]; result: Awaited<ReturnType<PaseoProviderActions["listControls"]>> };

export const codexControls = {
  "draft": {
    "provider": "codex/gpt-6.1-sol",
    "cwd": "/repo",
    "providerOptions": {
      "sandbox_mode": "read-only",
      "approval_policy": "never"
    }
  },
  "result": {
    "provider": "codex",
    "controls": [
      {
        "type": "select",
        "key": "service_tier",
        "label": "Speed",
        "description": "Choose processing speed. Faster tiers increase usage.",
        "tooltip": "Select speed",
        "icon": "zap",
        "desktopTrigger": "icon",
        "defaultValue": "default",
        "choices": [
          {
            "value": "default",
            "label": "Normal"
          },
          {
            "value": "flex",
            "label": "Flex"
          },
          {
            "value": "priority",
            "label": "Fast"
          }
        ]
      },
      {
        "type": "toggle",
        "key": "plan_mode",
        "label": "Plan",
        "description": "Switch Codex into planning-only collaboration mode",
        "tooltip": "Toggle plan mode",
        "icon": "list-todo"
      }
    ],
    "options": {
      "sandbox_mode": "read-only",
      "approval_policy": "never"
    },
    "error": null,
    "fetchedAt": "2026-11-20T18:30:46.637Z",
    "requestId": "71d52273-7bfd-4782-a162-3fec9246b33e"
  }
} satisfies { draft: Parameters<PaseoProviderActions["listControls"]>[0]; result: Awaited<ReturnType<PaseoProviderActions["listControls"]>> };

export function routingSnapshot(entries: Awaited<ReturnType<PaseoProviderActions["waitForReady"]>>["entries"]) {
  return { ...liveSnapshot, entries };
}

export function routingModels(provider: string, models: Omit<NonNullable<Awaited<ReturnType<PaseoProviderActions["listModels"]>>["models"]>[number], "provider">[]) {
  return { provider, models: models.map(model => ({ ...model, provider })), fetchedAt: codexControls.result.fetchedAt, requestId: "models" };
}

export const routingControls: PaseoProviderActions["listControls"] = async draft => ({
  ...codexControls.result, provider: draft.provider.split("/")[0], options: draft.providerOptions,
});
