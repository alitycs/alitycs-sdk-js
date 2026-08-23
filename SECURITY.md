# Security policy

## Supported versions

Security fixes are provided for the latest `1.x` release. Older releases may be asked to upgrade
before a fix is issued.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/alitycs/alitycs-sdk-js/security/advisories/new).
Do not open a public issue or discussion for a suspected vulnerability.

Include the affected package and version, impact, reproduction steps, and any suggested mitigation.
Please avoid accessing data that is not yours and give maintainers reasonable time to investigate
before public disclosure.

The SDK is a best-effort event collector. Never embed secret API keys in browser code; browser
integrations must use publishable keys. Rotate any credential that may have been exposed.
