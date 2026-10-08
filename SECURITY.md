# Security

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. If that is unavailable, email **me@acltabontabon.com** with "Cruce security" in the subject.

Do not open a public issue, pull request or discussion for a suspected vulnerability. Include the affected version or commit, the steps to reproduce and the impact you observed. Expect an acknowledgement within a few days; fixes are released as a new version with a changelog entry once the issue is resolved.

## Supported versions

Cruce is in alpha. Only the latest release and `main` receive security fixes.

## Scope

In scope: the control-plane Worker in `src/worker`, the console in `src/ui`, the local runner and Git credential helper in `runner`, and the published client package. Of particular interest are anything that exposes sealed credentials or Git tokens, bypasses membership, repository grants or connection approval, lets a promotion land without authenticated human approval, or lets one namespace read or reserve another's resources.

Out of scope: vulnerabilities in Cloudflare, GitHub or other third-party services themselves, and installations that are not running a supported version. Test only against your own installation; never against `cruce.acltabontabon.com` or other people's deployments.
