/**
 * AAA (Arrange / Act / Assert) helpers for non-test automation.
 *
 * - **Arrange**: build browser context, data, and preconditions.
 * - **Act**: perform the user flow via page objects.
 * - **Assert**: verify outcomes and map DOM/state into result DTOs (not only test assertions).
 */

export type AaaPhases<TContext, TOutcome> = {
  arrange: () => Promise<TContext>;
  act: (ctx: TContext) => Promise<TOutcome>;
  assert: (outcome: TOutcome, ctx: TContext) => Promise<void> | void;
};

/**
 * Runs the three phases in order and returns context + outcome for the caller to persist.
 */
export async function runAaaPhases<TContext, TOutcome>(
  phases: AaaPhases<TContext, TOutcome>
): Promise<{ ctx: TContext; outcome: TOutcome }> {
  const ctx = await phases.arrange();
  const outcome = await phases.act(ctx);
  await phases.assert(outcome, ctx);
  return { ctx, outcome };
}
