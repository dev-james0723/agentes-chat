import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { SHARED_MEMORY_TABS, SharedMemoryPage, type SharedMemoryTab } from "@/pages/SharedMemoryPage";

export const Route = createFileRoute("/org/$orgId/shared-memory")({
  validateSearch: (search: Record<string, unknown>): { tab?: SharedMemoryTab; item?: string } => ({
    tab:
      typeof search.tab === "string" && SHARED_MEMORY_TABS.includes(search.tab as SharedMemoryTab)
        ? (search.tab as SharedMemoryTab)
        : undefined,
    item: typeof search.item === "string" ? search.item : undefined,
  }),
  component: function Page() {
    const search = Route.useSearch();
    return (
      <Main>
        <SharedMemoryPage initialTab={search.tab} linkedEntry={search.item} />
      </Main>
    );
  },
});
