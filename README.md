# Turner Finance Futures Program

A small, hostable website for a college case study workflow for Turner Construction Company. It includes a default student view and a password-protected host view.

## What is included

- Student view is the default page.
- A small bottom button labeled `host view` opens the host login.
- Host password defaults to `123` as requested.
- Host can publish an Excel/CSV case document and an instruction checklist.
- Student view shows `Waiting for host to begin case study.` until the host publishes.
- Students can download the case document, complete checklist items, see progress, chat with the AI Boss, and upload a completed case document.
- Host can review submissions, download submitted files, see an AI Boss interaction report for each student, and export the comparison table to CSV.
- AI Boss refuses final-answer requests and redirects students toward source-finding, reasoning, planning, and debugging.

## Run locally

This app uses Node.js built-in modules only. No package installation is required.

```bash
cd turner-finance-futures-program
npm start
```

Then open:

```text
http://localhost:3000
```

## Host password

Default password:

```text
123
```

To change it when running the server:

```bash
HOST_PASSWORD="new-password" npm start
```

On Windows PowerShell:

```powershell
$env:HOST_PASSWORD="new-password"; npm start
```

## File storage

Uploaded case files and student submissions are stored on the server under:

```text
storage/uploads
```

Submission and case metadata are stored in:

```text
storage/db.json
```

The host view includes a reset button that deletes the published case and all stored submissions.

## Real AI integration notes

The included AI Boss is a deterministic coaching simulator so the website works immediately without exposing an API key in the browser. It produces useful interaction reports by classifying student prompts as answer-seeking, source-location guidance, debugging, conceptual help, planning, vague, or general coaching.

For a production real-AI version, keep model calls on the server, not in browser JavaScript. Replace or extend these functions in `server.js`:

- `generateAiBossReply(...)`
- `generateSubmissionReport(...)`

A host can also paste a shared Custom GPT link in the publish form. The student page will show an `Open Custom GPT` button alongside the in-page AI Boss. The in-page AI Boss remains useful because it logs interactions for host comparison reports.

## Production checklist

Before using this with real students, consider adding:

- School single sign-on or a proper authentication provider.
- Persistent database storage instead of the local JSON file.
- Cloud file storage for submitted Excel documents.
- HTTPS.
- FERPA/privacy review if student data is collected.
- Server-side virus scanning for uploaded files.
- A real model endpoint if you want live AI rather than the built-in coaching simulator.

## Custom GPT instruction starter

See `CUSTOM_GPT_INSTRUCTIONS.md` for a paste-ready prompt to create a coaching-only GPT in ChatGPT.
