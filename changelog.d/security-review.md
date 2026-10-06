### Security

- Security review against the OWASP Mobile Top 10 (docs/security-review.md). Fixed: the web view is no
  longer inspectable in Release builds; the local file router only serves files inside the web bundle;
  navigations to non-web schemes are refused; core log lines are private in the Release system log;
  cookie copies use RFC 6265 domain matching; deep-link paths must stay on the source's own site.
