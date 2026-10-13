import { useStore } from './store'
import { useEffect, useState } from 'react'
import type { Action, Json } from '../shared/schema'
import { definitions } from '../shared/catalog'
export function JsonEditor({
  value,
  onChange,
  label = 'Configuration'
}: {
  value: Json
  onChange: (v: Json) => void
  label?: string
}) {
  const [text, setText] = useState(JSON.stringify(value, null, 2)),
    [error, setError] = useState('')
  useEffect(() => {
    setText(JSON.stringify(value, null, 2))
  }, [value])
  return (
    <label className="field">
      {label}
      <textarea
        aria-label={label}
        spellCheck={false}
        className="code"
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          try {
            const v = JSON.parse(e.target.value)
            onChange(v)
            setError('')
          } catch {
            setError('Enter valid JSON')
          }
        }}
      />
      {error && <small className="error">{error}</small>}
    </label>
  )
}
export function ActionEditor({
  action,
  onChange,
  onRemove
}: {
  action: Action
  onChange: (a: Action) => void
  onRemove?: () => void
}) {
  const config = useStore((s) => s.draft)
  const definition = definitions.find((d) => d.id === action.type)
  return (
    <div className="action-editor">
      <div className="row">
        <span className="accent">{definition?.icon}</span>
        <strong>{definition?.name ?? action.type}</strong>
        {onRemove && (
          <button className="icon-button push" aria-label="Remove action" onClick={onRemove}>
            ×
          </button>
        )}
      </div>
      {Object.entries({ ...definition?.defaults, ...action.config }).map(([key, value]) => {
        const set = (v: Json) => onChange({ ...action, config: { ...action.config, [key]: v } })
        const label = key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())
        if (typeof value === 'boolean')
          return (
            <label className="check" key={key}>
              <input type="checkbox" checked={value} onChange={(e) => set(e.target.checked)} />
              {label}
            </label>
          )
        if (typeof value === 'number')
          return (
            <label className="field" key={key}>
              {label}
              <input type="number" value={value} onChange={(e) => set(Number(e.target.value))} />
            </label>
          )
        const choices =
          key === 'connection'
            ? config?.connections.map((c) => ({ id: c.id, name: c.name }))
            : key === 'profileId'
              ? config?.profiles.map((p) => ({ id: p.id, name: p.name }))
              : key === 'pageId'
                ? config?.profiles.flatMap((p) =>
                    p.pages.map((pg) => ({ id: pg.id, name: p.name + ' / ' + pg.name }))
                  )
                : key === 'workflowId'
                  ? config?.workflows.map((w) => ({ id: w.id, name: w.name }))
                  : undefined
        if (choices)
          return (
            <label className="field" key={key}>
              {label}
              <select value={String(value)} onChange={(e) => set(e.target.value)}>
                <option value="">Choose {label.toLowerCase()}</option>
                {choices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          )
        if (typeof value === 'string')
          return (
            <label className="field" key={key}>
              {label}
              <input value={value} onChange={(e) => set(e.target.value)} />
            </label>
          )
        return <JsonEditor key={key} label={label} value={value as Json} onChange={set} />
      })}
      <details>
        <summary>Data bindings & credential reference</summary>
        <p className="muted">
          Use {'{{inputs.name}}'}, {'{{vars.name}}'}, or {'{{nodes.nodeId.field|fallback}}'} in a
          field. Output references never rerun an action.
        </p>
        <JsonEditor
          value={action.config}
          onChange={(v) => {
            if (v && typeof v === 'object' && !Array.isArray(v)) onChange({ ...action, config: v })
          }}
        />
      </details>
    </div>
  )
}
export function Catalog({ onPick }: { onPick: (id: string) => void }) {
  const [search, setSearch] = useState('')
  return (
    <>
      <div className="section-label">ACTION LIBRARY</div>
      <input
        className="search"
        aria-label="Search actions"
        placeholder="Search actions…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {['Developer', 'Desktop', 'Streaming', 'Deck'].map((group) => (
        <div key={group}>
          <div className="group-label">{group}</div>
          {definitions
            .filter((d) => d.group === group && d.name.toLowerCase().includes(search.toLowerCase()))
            .map((d) => (
              <button
                className="catalog-item"
                key={d.id}
                draggable
                onDragStart={(e) => e.dataTransfer.setData('decker/action', d.id)}
                onClick={() => onPick(d.id)}
              >
                <span className="catalog-icon">{d.icon}</span>
                <span>{d.name}</span>
                <span className="push muted">+</span>
              </button>
            ))}
        </div>
      ))}
    </>
  )
}
export function newAction(id: string): Action {
  const d = definitions.find((d) => d.id === id)!
  return { type: id, version: 1, config: structuredClone(d.defaults) as Record<string, Json> }
}
