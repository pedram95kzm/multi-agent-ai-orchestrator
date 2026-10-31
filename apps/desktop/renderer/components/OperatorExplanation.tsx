export function OperatorExplanation({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      Operator explanation (optional)
      <textarea
        value={value}
        placeholder="Add any extra context…"
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
