export function Legend({ series }: { series: { name: string; color: string }[] }) {
  if (series.length < 2) return null;
  return (
    <div className="legend">
      {series.map((s) => (
        <span key={s.name} style={{ ['--c' as string]: s.color }}>
          {s.name}
        </span>
      ))}
    </div>
  );
}
