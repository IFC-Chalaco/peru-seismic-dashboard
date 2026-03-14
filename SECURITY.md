# Security Policy

## Supported Scope

This repository publishes a public seismic dashboard and automated public-data pipeline.

Security-sensitive areas include:

- GitHub Actions workflows under `.github/workflows/`
- published website code under `docs/`
- ingestion and export logic under `seismic_bi_stream/`

This repository is designed to avoid storing secrets in source control. Public data sources and non-sensitive GitHub Actions variables may be used for configuration.

## Reporting a Vulnerability

If you find a security issue, please do not post it publicly in an issue.

Instead:

1. Open a private GitHub security advisory if available for the repository.
2. If that is not available, contact the repository owner directly and include:
   - a short description of the issue
   - reproduction steps
   - impact assessment
   - any suggested mitigation

Please allow reasonable time for investigation and remediation before public disclosure.

## Current Security Posture

The repository follows these baseline practices:

- least-privilege GitHub Actions permissions
- no committed credentials or tokens
- automated workflow monitoring for stale pipeline behavior
- public-data-only publication outputs

Additional GitHub account and repository protections should also be enabled in the GitHub UI, including strong authentication and branch protection.
