import { Button } from '../../components/ui';
import { FilterSelect, SearchInput } from '../../components/data';
import {
  FILTER_OPERATORS,
  VALUELESS_OPERATORS,
  type ExplorerColumn,
  type ExplorerFilter,
  type FilterOperator,
} from '../../api/opsExplorer';

/** Operators that make sense per column type — offering `contains` on a boolean is just a 400 waiting. */
const OPERATORS_BY_TYPE: Record<ExplorerColumn['type'], FilterOperator[]> = {
  string: ['contains', 'startsWith', 'eq', 'neq', 'in', 'isNull', 'isNotNull'],
  enum: ['eq', 'neq', 'in', 'isNull', 'isNotNull'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'isNull', 'isNotNull'],
  date: ['gt', 'gte', 'lt', 'lte', 'between', 'isNull', 'isNotNull'],
  boolean: ['eq', 'isNull', 'isNotNull'],
};

const OPERATOR_LABEL: Record<FilterOperator, string> = {
  eq: 'is',
  neq: 'is not',
  contains: 'contains',
  startsWith: 'starts with',
  in: 'is one of',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  between: 'between',
  isNull: 'is blank',
  isNotNull: 'is not blank',
};

/**
 * The advanced filter builder: a stack of `column · operator · value` rows, ANDed.
 *
 * AND-only is a deliberate v1 limit rather than an oversight. An OR/group tree is a materially bigger
 * UI and a materially bigger request shape, and every reconciliation question this tool was built for
 * ("show me the departed devices in South with no ping since X") is a conjunction. Global search already
 * covers the one common disjunction — the same term across several columns.
 *
 * Values are kept as strings in the row state and coerced by the SERVER against the registry's declared
 * type. The client deliberately does not pre-coerce: the backend's coercion is the one that decides, and
 * a second, client-side opinion about "is 24 a number here" is exactly the drift this whole feature
 * exists to eliminate. What the client does do is offer the right operators and a value picker for enums
 * and booleans, so most rows are unambiguous before they are sent.
 */
export function FilterBuilder({
  columns,
  filters,
  onChange,
}: {
  columns: ExplorerColumn[];
  filters: ExplorerFilter[];
  onChange: (next: ExplorerFilter[]) => void;
}) {
  const filterable = columns.filter((c) => c.filterable);
  const byKey = new Map(columns.map((c) => [c.key, c]));

  const update = (index: number, patch: Partial<ExplorerFilter>) =>
    onChange(filters.map((f, i) => (i === index ? { ...f, ...patch } : f)));

  const add = () => {
    const first = filterable[0];
    if (!first) return;
    onChange([...filters, { column: first.key, operator: OPERATORS_BY_TYPE[first.type][0], value: '' }]);
  };

  return (
    <div className="space-y-2" data-testid="ops-explorer-filters">
      {filters.map((filter, index) => {
        const column = byKey.get(filter.column);
        const operators = column ? OPERATORS_BY_TYPE[column.type] : [...FILTER_OPERATORS];
        const needsValue = !VALUELESS_OPERATORS.includes(filter.operator);
        const isRange = filter.operator === 'between';
        const range = Array.isArray(filter.value) ? (filter.value as unknown[]) : ['', ''];

        return (
          <div key={index} className="flex flex-wrap items-center gap-2">
            <FilterSelect
              aria-label={`Filter ${index + 1} column`}
              value={filter.column}
              onChange={(e) => {
                const next = byKey.get(e.target.value);
                // Changing the column can invalidate the operator (e.g. `contains` → a number column),
                // so the operator resets to that type's first legal one rather than 400-ing on submit.
                update(index, {
                  column: e.target.value,
                  operator: next ? OPERATORS_BY_TYPE[next.type][0] : 'eq',
                  value: '',
                });
              }}
            >
              {filterable.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </FilterSelect>

            <FilterSelect
              aria-label={`Filter ${index + 1} operator`}
              value={filter.operator}
              onChange={(e) =>
                update(index, {
                  operator: e.target.value as FilterOperator,
                  value: e.target.value === 'between' ? ['', ''] : '',
                })
              }
            >
              {operators.map((op) => (
                <option key={op} value={op}>
                  {OPERATOR_LABEL[op]}
                </option>
              ))}
            </FilterSelect>

            {needsValue && isRange && (
              <>
                <SearchInput
                  aria-label={`Filter ${index + 1} from`}
                  placeholder="from"
                  value={String(range[0] ?? '')}
                  onChange={(e) => update(index, { value: [e.target.value, range[1] ?? ''] })}
                  className="w-32"
                />
                <SearchInput
                  aria-label={`Filter ${index + 1} to`}
                  placeholder="to"
                  value={String(range[1] ?? '')}
                  onChange={(e) => update(index, { value: [range[0] ?? '', e.target.value] })}
                  className="w-32"
                />
              </>
            )}

            {needsValue && !isRange && column?.type === 'boolean' && (
              <FilterSelect
                aria-label={`Filter ${index + 1} value`}
                value={String(filter.value ?? '')}
                onChange={(e) => update(index, { value: e.target.value })}
              >
                <option value="">—</option>
                <option value="true">true</option>
                <option value="false">false</option>
              </FilterSelect>
            )}

            {needsValue && !isRange && column?.type === 'enum' && filter.operator !== 'in' && (
              <FilterSelect
                aria-label={`Filter ${index + 1} value`}
                value={String(filter.value ?? '')}
                onChange={(e) => update(index, { value: e.target.value })}
              >
                <option value="">—</option>
                {(column.enumValues ?? []).map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </FilterSelect>
            )}

            {needsValue &&
              !isRange &&
              (column?.type === 'string' || column?.type === 'number' || column?.type === 'date' || filter.operator === 'in') && (
                <SearchInput
                  aria-label={`Filter ${index + 1} value`}
                  placeholder={filter.operator === 'in' ? 'comma-separated' : 'value'}
                  value={Array.isArray(filter.value) ? (filter.value as string[]).join(', ') : String(filter.value ?? '')}
                  onChange={(e) =>
                    update(index, {
                      value:
                        filter.operator === 'in'
                          ? e.target.value.split(',').map((s) => s.trim()).filter(Boolean)
                          : e.target.value,
                    })
                  }
                  className="w-56"
                />
              )}

            <Button
              variant="ghost"
              size="sm"
              aria-label={`Remove filter ${index + 1}`}
              onClick={() => onChange(filters.filter((_, i) => i !== index))}
            >
              Remove
            </Button>
          </div>
        );
      })}

      <Button variant="secondary" size="sm" onClick={add} data-testid="ops-explorer-add-filter">
        + Add filter
      </Button>
    </div>
  );
}
