# Security policy

## Supported versions

Security fixes are provided for the latest released version. Older versions may receive fixes at the maintainers' discretion.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use the repository's private security-advisory reporting feature and include:

- affected version or commit;
- impact and prerequisites;
- reproduction steps or a minimal proof of concept;
- any suggested remediation.

Do not access data you do not own, disrupt running services, or publish details before maintainers have had a reasonable opportunity to investigate and release a fix. Maintainers aim to acknowledge a complete report within three business days, provide a status update within seven days, and coordinate remediation and disclosure with the reporter. Complex fixes may take longer; material delays will be communicated.

## Deployment responsibility

Keyzori is self-hosted. Operators are responsible for TLS termination, network isolation, secret management, dependency updates, database backups, monitoring, and timely upgrades. See [the Deployment wiki page](https://github.com/keyzori/keyzori/wiki/Deployment).
