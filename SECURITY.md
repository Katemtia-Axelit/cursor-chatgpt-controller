# Security considerations

This directory is a sanitized source snapshot, **not** a copy of a live Controller runtime.

- Never upload `bridge-config.json`, `visible-tab-secret.json`, event files, task records, private prompts, raw handoffs, browser storage, cookies or machine logs.
- Keep the Cursor CDP listener on `127.0.0.1` only and verify its owning process, profile and workspace before any GUI interaction.
- Require explicit ChatGPT project-chat binding and a fresh extension heartbeat before delivering messages.
- Use exact file write allowlists and preserve the original Controller Review before any production integration.
- Treat `SEND_INTENT_NO_AUTO_RETRY` and ambiguous sends as final until reviewed; never blindly rerun the same task token.
- Do not include private filesystem paths or credentials in manifests committed to Git.
- The example manifest is for `plan` only. No task should be sent from a demonstration checkout without a local configuration audit.

The snapshot may require adaptation for different Cursor versions and their CDP element selectors. It does not grant access to anyone's machine by itself.
