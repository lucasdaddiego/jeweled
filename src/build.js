// Build identifier shown in the title scene footer and useful when filing
// bug reports. The deploy workflow (.github/workflows/deploy.yml) rewrites
// the 'dev' literal below to the short commit SHA at deploy time. Local
// development stays as 'dev' so it's obvious which builds came from CI.
export const BUILD = 'dev';
