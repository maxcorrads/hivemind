import { modelChoiceGroups, parseChoiceId, selectedChoiceId } from "../src/shared/launch-models.ts";
import { effectiveSoftware, softwareFamily } from "../src/shared/launch-prompt.ts";

/** The model and effort picker of the Launch sheet and the worker template editor. */
export function ModelSelect({
  software,
  model,
  effort,
  inherit,
  onChange,
}: {
  software: string;
  model: string;
  effort: string;
  inherit?: string;
  onChange: (next: { model: string; effort: string }) => void;
}) {
  const alias = effectiveSoftware(software);
  const groups = modelChoiceGroups(alias);
  const value = selectedChoiceId(alias, model, effort);
  const known = new Set(groups.flatMap((g) => g.choices.map((c) => c.id)));
  const extraEffort = softwareFamily(alias) === "cursor" ? "" : effort;
  return (
    <label>
      Model
      <select
        value={value}
        onChange={(e) => {
          const id = e.target.value;
          if (!id) {
            onChange({ model: "", effort: "" });
            return;
          }
          const hit = groups.flatMap((g) => g.choices).find((c) => c.id === id);
          onChange(hit ? { model: hit.model, effort: hit.effort } : parseChoiceId(id));
        }}
      >
        <option value="">{inherit ? `same as above (${inherit})` : "default"}</option>
        {value && !known.has(value) && (
          <option value={value}>{extraEffort ? `${model} · ${extraEffort}` : model}</option>
        )}
        {groups.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.choices.map((choice) => (
              <option key={`${group.label}:${choice.id}`} value={choice.id}>
                {choice.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}
