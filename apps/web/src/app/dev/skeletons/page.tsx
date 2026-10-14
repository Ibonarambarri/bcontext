import { notFound } from "next/navigation";
import {
  BoardSkeleton,
  DashboardSkeleton,
  DetailSkeleton,
  GraphSkeleton,
  GridSkeleton,
  ListSkeleton,
  NodePageSkeleton,
  ViewSkeleton,
} from "@/components/skeletons";

/**
 * Dev-only gallery of the standardized skeleton system — every loading
 * placeholder the app uses, on one page, for visual QA in light and dark.
 * Returns 404 in production builds.
 */
export default function SkeletonGalleryPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <main className="mx-auto max-w-6xl space-y-10 px-6 py-10 text-[13px]">
      <h1 className="text-xl font-semibold">Skeleton system — dev gallery</h1>

      <Section title="DashboardSkeleton (/w/[org]/[ws] overview)">
        <div className="h-[760px] overflow-hidden rounded-xl border border-[var(--line)]">
          <DashboardSkeleton />
        </div>
      </Section>

      <Section title="GridSkeleton (Agents · Tools · Integrations · Workspaces)">
        <GridSkeleton cards={3} className="mt-0" />
      </Section>

      <Section title="ListSkeleton (Activity feed · lists)">
        <ListSkeleton rows={4} />
      </Section>

      <Section title="ViewSkeleton (saved list views)">
        <div className="h-[360px] overflow-hidden rounded-xl border border-[var(--line)]">
          <ViewSkeleton rows={6} />
        </div>
      </Section>

      <Section title="BoardSkeleton (task/review boards)">
        <BoardSkeleton className="mt-0" />
      </Section>

      <Section title="GraphSkeleton (graph canvas · tags)">
        <div className="h-[380px] overflow-hidden rounded-xl border border-[var(--line)]">
          <GraphSkeleton />
        </div>
      </Section>

      <div className="grid gap-6 md:grid-cols-2">
        <Section title="DetailSkeleton (inspector)">
          <div className="rounded-xl border border-[var(--line)]">
            <DetailSkeleton />
          </div>
        </Section>
        <Section title="NodePageSkeleton (editor)">
          <div className="h-[400px] overflow-hidden rounded-xl border border-[var(--line)]">
            <NodePageSkeleton />
          </div>
        </Section>
      </div>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 font-mono text-[11px] uppercase tracking-widest text-[var(--ink-3)]">{title}</h2>
      {children}
    </section>
  );
}
