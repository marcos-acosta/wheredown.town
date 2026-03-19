export const classes = (...classnames: (string | null | false | undefined)[]) =>
  classnames.filter(Boolean).join(" ");
