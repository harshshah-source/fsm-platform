import { useState } from 'react';
import { Badge, type BadgeTone } from '../components/ui/Badge';
import { Button, type ButtonVariant } from '../components/ui/Button';
import { Card, SectionCard } from '../components/ui/Card';
import { Field, Input } from '../components/ui/Input';
import { DataTable, type Column } from '../components/data/DataTable';
import { DateRangeChips } from '../components/data/DateRangeChips';
import { MetricStrip } from '../components/data/MetricStrip';
import { AgeChip, EntityBadge, SLABadge, StatusPill, TierBadge } from '../components/domain/badges';
import { TicketCard } from '../components/domain/TicketCard';
import { BarChartCard } from '../components/charts/BarChartCard';
import { ChartCard } from '../components/charts/ChartCard';
import { ChartLegend, DonutChart } from '../components/charts/DonutChart';
import { DistributionBar } from '../components/charts/DistributionBar';
import { RadialGauge } from '../components/charts/RadialGauge';
import { TrendChart } from '../components/charts/TrendChart';
import { CHART } from '../components/charts/colors';
import { Tab, TabList, TabPanel, Tabs } from '../components/overlay/Tabs';
import { Modal } from '../components/overlay/Modal';
import { Sheet } from '../components/overlay/Sheet';
import { Select } from '../components/overlay/Select';
import { DropdownMenu } from '../components/overlay/DropdownMenu';
import { SLA_BUCKETS } from '../lib/slaBucket';

const VARIANTS: ButtonVariant[] = ['primary', 'secondary', 'danger', 'ghost'];
const TONES: BadgeTone[] = ['info', 'success', 'verified', 'warning', 'critical', 'neutral', 'brand'];
const STATUSES = ['OPEN', 'VERIFICATION_PENDING', 'CLOSED', 'ESCALATED', 'SHIPPED', 'REJECTED', 'TIMED_OUT'];

interface DemoRow {
  id: string;
  device: string;
  tier: string;
  bucket: string;
}
const DEMO_ROWS: DemoRow[] = [
  { id: '1', device: 'GPS-900', tier: 'PLATINUM', bucket: 'CRITICAL' },
  { id: '2', device: 'GPS-901', tier: 'GOLD', bucket: 'RISK' },
  { id: '3', device: 'GPS-902', tier: 'SILVER', bucket: 'WARNING' },
];

/**
 * Dev-only visual audit surface (FE-00/FE-01/FE-03/FE-04). Renders every design-system primitive,
 * domain badge, and overlay so the Playwright parity harness and humans can eyeball them. Mounted only
 * when `import.meta.env.DEV`.
 */
export function KitchenSink() {
  const [tab, setTab] = useState('overview');
  const [sel, setSel] = useState<string | null>(null);
  const [modal, setModal] = useState(false);
  const [sheet, setSheet] = useState(false);

  const cols: Column<DemoRow>[] = [
    { key: 'device', header: 'Device', render: (r) => <span className="font-medium">{r.device}</span> },
    { key: 'tier', header: 'Tier', render: (r) => <TierBadge tier={r.tier} /> },
    { key: 'bucket', header: 'Bucket', render: (r) => <SLABadge bucket={r.bucket} /> },
  ];

  return (
    <div className="min-h-screen space-y-8 p-8">
      <h1 className="text-xl font-semibold text-ink-strong">Design-system kitchen sink</h1>

      <SectionCard title="Buttons">
        <div className="flex flex-wrap items-center gap-3">
          {VARIANTS.map((v) => (
            <Button key={v} variant={v}>
              {v}
            </Button>
          ))}
          <Button loading>loading</Button>
          <Button disabled>disabled</Button>
          <Button size="sm">sm</Button>
          <Button size="lg">lg</Button>
        </div>
      </SectionCard>

      <SectionCard title="Badges (tones)">
        <div className="flex flex-wrap items-center gap-2">
          {TONES.map((t) => (
            <Badge key={t} tone={t} dot>
              {t}
            </Badge>
          ))}
        </div>
      </SectionCard>

      <SectionCard title="Domain badges">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {SLA_BUCKETS.map((b) => (
              <SLABadge key={b} bucket={b} />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {STATUSES.map((s) => (
              <StatusPill key={s} status={s} />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <TierBadge tier="PLATINUM" />
            <TierBadge tier="GOLD" />
            <TierBadge tier="SILVER" />
            <AgeChip days={2} />
            <AgeChip days={5} />
            <AgeChip days={10} />
            <AgeChip days={20} />
            <EntityBadge value="Plant 7" />
          </div>
        </div>
      </SectionCard>

      <SectionCard title="MetricStrip + DateRangeChips">
        <DateRangeChips />
        <MetricStrip
          cols={4}
          metrics={[
            { label: 'Uptime', value: '94.2%', tone: 'success', hint: '↑ 1.2%' },
            { label: 'Open Tickets', value: 46, tone: 'brand' },
            { label: 'Critical', value: 8, tone: 'critical' },
            { label: 'Verified', value: 25, tone: 'verified' },
          ]}
        />
      </SectionCard>

      <SectionCard title="DataTable">
        <DataTable ariaLabel="Demo table" columns={cols} rows={DEMO_ROWS} rowKey={(r) => r.id} />
      </SectionCard>

      <SectionCard title="TicketCard">
        <div className="grid gap-3 md:grid-cols-2">
          <TicketCard
            title="GPS-900 · TKT-TS-10231"
            subtitle="Mumbai Plant · Nuvoco"
            tier="PLATINUM"
            bucket="CRITICAL"
            status="OPEN"
            meta="39h inactive"
            accent="border-l-critical"
            actions={<Button size="sm">Assign</Button>}
          />
          <TicketCard title="GPS-901 · TKT-TS-10232" subtitle="Surat Plant · JSW" tier="GOLD" bucket="RISK" status="VERIFICATION_PENDING" meta="6h inactive" />
        </div>
      </SectionCard>

      <SectionCard title="Charts">
        <div className="grid gap-4 md:grid-cols-2">
          <ChartCard title="Inactivity by SLA bucket">
            <BarChartCard
              data={[
                { name: 'Critical', value: 28, color: CHART.critical },
                { name: 'High', value: 19, color: CHART.warning },
                { name: 'Risk', value: 12, color: CHART.info },
                { name: 'Warning', value: 6, color: CHART.neutral },
              ]}
            />
          </ChartCard>
          <ChartCard title="Verification outcomes">
            <div className="grid items-center gap-4 sm:grid-cols-[200px_1fr]">
              <DonutChart
                data={[
                  { name: 'Closed', value: 25, color: CHART.success },
                  { name: 'Partial', value: 8, color: CHART.warning },
                  { name: 'Failed', value: 5, color: CHART.critical },
                ]}
                height={180}
              />
              <ChartLegend
                items={[
                  { name: 'Closed', value: 25, color: CHART.success },
                  { name: 'Partial', value: 8, color: CHART.warning },
                  { name: 'Failed', value: 5, color: CHART.critical },
                ]}
              />
            </div>
          </ChartCard>
          <ChartCard title="Fleet uptime trend">
            <TrendChart
              data={[
                { label: 'Mar', value: 91 },
                { label: 'Apr', value: 93 },
                { label: 'May', value: 92 },
                { label: 'Jun', value: 94 },
              ]}
            />
          </ChartCard>
          <ChartCard title="Workload / SLA distribution">
            <div className="flex items-center gap-6">
              <RadialGauge value={72} label="utilization" />
              <DistributionBar
                className="flex-1"
                segments={[
                  { label: 'Warning', value: 12, color: CHART.success },
                  { label: 'Risk', value: 9, color: CHART.warning },
                  { label: 'Critical', value: 6, color: CHART.critical },
                  { label: 'Severe', value: 3, color: CHART.criticalDeep },
                ]}
              />
            </div>
          </ChartCard>
        </div>
      </SectionCard>

      <SectionCard title="Overlays">
        <div className="space-y-4">
          <Tabs value={tab} onValueChange={setTab}>
            <TabList aria-label="Demo tabs">
              <Tab value="overview">Overview</Tab>
              <Tab value="lifecycle">Lifecycle</Tab>
              <Tab value="forms">Forms</Tab>
            </TabList>
            <TabPanel value="overview" className="pt-3 text-sm">
              Overview panel
            </TabPanel>
            <TabPanel value="lifecycle" className="pt-3 text-sm">
              Lifecycle panel
            </TabPanel>
            <TabPanel value="forms" className="pt-3 text-sm">
              Forms panel
            </TabPanel>
          </Tabs>

          <div className="flex flex-wrap items-center gap-3">
            <Select
              aria-label="Demo select"
              value={sel}
              onChange={setSel}
              options={[
                { value: 'a', label: 'Option A' },
                { value: 'b', label: 'Option B' },
                { value: 'c', label: 'Option C' },
              ]}
            />
            <DropdownMenu
              aria-label="Row actions"
              trigger={<span className="rounded-md border border-line px-2 py-1 text-sm">Actions ▾</span>}
              items={[
                { label: 'Reassign', onSelect: () => undefined },
                { label: 'Override', onSelect: () => undefined },
                { label: 'Close', onSelect: () => undefined, tone: 'danger' },
              ]}
            />
            <Button variant="secondary" onClick={() => setModal(true)}>
              Open Modal
            </Button>
            <Button variant="secondary" onClick={() => setSheet(true)}>
              Open Sheet
            </Button>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Inputs">
        <div className="grid max-w-md gap-4">
          <Field label="Email Address" htmlFor="ks-email">
            <Input id="ks-email" placeholder="zone.head@autoplant.in" />
          </Field>
          <Field label="Disabled" htmlFor="ks-disabled">
            <Input id="ks-disabled" disabled placeholder="disabled" />
          </Field>
        </div>
      </SectionCard>

      <SectionCard title="Cards">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Card className="p-4">Plain Card</Card>
          <SectionCard title="With header" action={<Badge tone="info">live</Badge>}>
            body content
          </SectionCard>
        </div>
      </SectionCard>

      <Modal
        open={modal}
        onClose={() => setModal(false)}
        title="Demo modal"
        footer={
          <>
            <Button variant="secondary" onClick={() => setModal(false)}>
              Cancel
            </Button>
            <Button onClick={() => setModal(false)}>Confirm</Button>
          </>
        }
      >
        <p className="text-sm text-ink">Modal body content.</p>
      </Modal>

      <Sheet open={sheet} onClose={() => setSheet(false)} title="Demo sheet" ariaLabel="Demo sheet">
        <p className="text-sm text-ink">Slide-over body content.</p>
      </Sheet>
    </div>
  );
}
