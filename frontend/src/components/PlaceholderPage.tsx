import { Card } from './Card';

/** Temporary stand-in while a screen is being built out — never shipped as a final state. */
export function PlaceholderPage({ title }: { title: string }) {
  return (
    <Card title={title}>
      <p className="text-[13px] text-text-secondary">This screen is under construction.</p>
    </Card>
  );
}
