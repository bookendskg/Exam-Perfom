# Exam-Perfom

An exam and performance management portal for certification and training bodies — delivering exams to candidates, scoring them, and keeping the certification records that come out the other side.

> **Status: early.** The repository is currently a scaffold. This README describes the intended shape of the project; sections marked _planned_ are not built yet.

## What it's for

Certification bodies run the same loop over and over: publish an exam, get candidates through it under supervision, score it consistently, and issue a record that someone downstream will need to verify. This portal aims to hold that whole loop in one place instead of spreading it across spreadsheets, a proctoring vendor, and a certificate mail-merge.

## Roles

| Role | Can do |
| --- | --- |
| Candidate | Register, sit scheduled exams, view results and earned certifications |
| Examiner | Author exams and question banks, supervise sittings, review and score submissions |
| Admin | Manage users, exam schedules, scoring rules, and certification records |

## Planned features

- **Exam authoring** — question banks, multiple question types, versioned exam papers
- **Scheduling** — exam windows, candidate enrolment, seat allocation
- **Delivery** — timed sittings with autosave, resume-after-disconnect
- **Proctoring** — session monitoring and integrity flags for examiner review
- **Scoring** — automatic marking where possible, examiner review queue for the rest
- **Certification records** — issued credentials with expiry and third-party verification
- **Reporting** — candidate performance over time, pass rates, question-level analytics

## Tech stack

- **Frontend:** React
- **Backend:** Node.js
- **Database:** TBD

## Getting started

### Prerequisites

- Node.js (LTS)
- npm

### Setup

```bash
git clone <repository-url>
cd Exam-Perfom
npm install
```

### Running locally

```bash
npm run dev
```

Copy `.env.example` to `.env` and fill in the required values before first run.

> Setup steps above are the intended standard flow — the scripts and `.env.example` land with the initial application code.

## Project structure

_To be documented once the application scaffold is in place._

## Contributing

Branch off `main`, keep commits scoped, and open a pull request describing what changed and how you verified it.

## License

Not yet specified.
