/**
 * Vendored from LNReader/lnreader-plugins `src/types/filters.ts` (MIT License,
 * Copyright (c) 2021 Rajarshee Chatterjee). Modified: the `FilterTypes` enum is
 * expressed as a const object + union type so it works with erasable-only TS.
 */

export const FilterTypes = {
  TextInput: 'Text',
  Picker: 'Picker',
  CheckboxGroup: 'Checkbox',
  Switch: 'Switch',
  ExcludableCheckboxGroup: 'XCheckbox',
} as const;
export type FilterTypes = (typeof FilterTypes)[keyof typeof FilterTypes];

export type FilterOption = {
  readonly label: string;
  readonly value: string;
};

type SwitchFilter = { type: 'Switch'; value: boolean };
type TextFilter = { type: 'Text'; value: string };
type CheckboxFilter = { type: 'Checkbox'; options: readonly FilterOption[]; value: string[] };
type PickerFilter = { type: 'Picker'; options: readonly FilterOption[]; value: string };
type ExcludableCheckboxFilter = {
  type: 'XCheckbox';
  options: readonly FilterOption[];
  value: { include?: string[]; exclude?: string[] };
};

type FilterFromType = {
  Checkbox: CheckboxFilter;
  XCheckbox: ExcludableCheckboxFilter;
  Picker: PickerFilter;
  Switch: SwitchFilter;
  Text: TextFilter;
};

export type Filter<Type extends FilterTypes> = { label: string } & FilterFromType[Type];

/** key → filter definition */
export type Filters = Record<string, Filter<FilterTypes>>;

export type ValueOfFilter<T extends FilterTypes> = FilterFromType[T]['value'];

export type FilterType<T extends { type: unknown }> = T extends { type: infer K }
  ? K extends FilterTypes
    ? K
    : never
  : never;

export type FilterValueWithType<T extends FilterTypes> = { value: ValueOfFilter<T>; type: T };

/** Filters stripped to `{ value, type }` pairs, as passed to `popularNovels`. */
export type FilterToValues<FilterObject extends Record<string, { type: FilterTypes }> | undefined> =
  FilterObject extends undefined
    ? undefined
    : {
        [K in keyof FilterObject]: FilterValueWithType<FilterType<NonNullable<FilterObject>[K]>>;
      };
