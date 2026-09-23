/** Observed availability of an executable on the user's login-shell PATH. */
export type BinaryAvailability = { source: 'system'; path: string } | { source: 'none' }

/** Main-computed PATH facts for one executable name. */
export type BinaryToolSnapshot = {
  name: string
  availability: BinaryAvailability
}
