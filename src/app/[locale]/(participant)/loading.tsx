// src/app/[locale]/(participant)/loading.tsx
//
// Route-segment loading boundary shared by both nested groups under
// (participant) — (shell) (my-application, schedule) and (bare) (claim,
// register). Placed at (participant)/ rather than duplicated in both
// nested groups since it has no dependency on which layout ends up
// wrapping it, unlike the AppShell-vs-bare-card split itself which DOES
// have to be nested per Step 3's layout-nesting technique (see
// (bare)/layout.tsx's doc comment for why layout.tsx itself could not
// stay at this level).
import { LoadingState } from '@/components/states/loading-state';

export default function ParticipantLoading() {
  return <LoadingState variant="page" />;
}
