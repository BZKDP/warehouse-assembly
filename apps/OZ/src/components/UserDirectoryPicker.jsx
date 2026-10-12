import { useEffect, useMemo, useRef, useState } from "react";

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function primaryLabel(option) {
  const fullName = String(option?.fullName || "").trim();
  const login = String(option?.login || "").trim();
  return fullName || login || "";
}

function secondaryLabel(option, duplicateNames) {
  const login = String(option?.login || "").trim();
  if (!login) return "";

  const primary = normalizeText(primaryLabel(option));
  if (!primary) return login;
  if ((duplicateNames.get(primary) || 0) > 1) return login;
  return "";
}

export default function UserDirectoryPicker({
  value,
  onChange,
  options,
  loading = false,
  disabled = false,
  placeholder = "Выберите сотрудника",
}) {
  const rootRef = useRef(null);
  const selectedOption = useMemo(
    () => (Array.isArray(options) ? options.find((entry) => String(entry.externalUserId) === String(value || "")) : null),
    [options, value]
  );
  const duplicateNames = useMemo(() => {
    const counts = new Map();
    for (const entry of Array.isArray(options) ? options : []) {
      const key = normalizeText(primaryLabel(entry));
      if (!key) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }, [options]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setQuery(selectedOption ? primaryLabel(selectedOption) : "");
  }, [selectedOption]);

  useEffect(() => {
    function handlePointerDown(event) {
      if (!rootRef.current?.contains(event.target)) {
        setOpen(false);
        setQuery(selectedOption ? primaryLabel(selectedOption) : "");
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [selectedOption]);

  const filteredOptions = useMemo(() => {
    const normalizedQuery = normalizeText(query);
    const source = Array.isArray(options) ? options : [];
    if (!normalizedQuery) return source;
    return source.filter((entry) => {
      const searchText = normalizeText(`${entry?.fullName || ""} ${entry?.login || ""}`);
      return searchText.includes(normalizedQuery);
    });
  }, [options, query]);

  function handleSelect(option) {
    onChange(String(option.externalUserId));
    setQuery(primaryLabel(option));
    setOpen(false);
  }

  function handleInputChange(nextValue) {
    setQuery(nextValue);
    setOpen(true);
    if (!nextValue.trim()) onChange("");
  }

  return (
    <div className={`directory-picker ${disabled ? "is-disabled" : ""}`} ref={rootRef}>
      <input
        className="input directory-picker-input"
        value={query}
        onChange={(e) => handleInputChange(e.target.value)}
        onFocus={() => setOpen(true)}
        placeholder={loading ? "Загрузка..." : placeholder}
        disabled={disabled}
      />
      {open && !disabled ? (
        <div className="directory-picker-popover">
          {loading ? (
            <div className="directory-picker-empty">Загрузка...</div>
          ) : filteredOptions.length === 0 ? (
            <div className="directory-picker-empty">Ничего не найдено</div>
          ) : (
            filteredOptions.map((entry) => {
              const secondary = secondaryLabel(entry, duplicateNames);
              return (
                <button
                  key={entry.externalUserId}
                  type="button"
                  className={`directory-picker-option ${String(entry.externalUserId) === String(value || "") ? "active" : ""}`}
                  onClick={() => handleSelect(entry)}
                  title={String(entry?.login || "").trim() || undefined}
                >
                  <span className="directory-picker-option-name">{primaryLabel(entry)}</span>
                  {secondary ? <span className="directory-picker-option-login">{secondary}</span> : null}
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
