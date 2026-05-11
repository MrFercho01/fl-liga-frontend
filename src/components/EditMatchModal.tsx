import { useState } from 'react'

interface Goal {
  playerId: string
  minute: string | number
  type: 'gol' | 'autogol' | 'penal'
}
interface Card {
  playerId: string
  type: 'TA' | 'TR'
  minute: string | number
}
interface Lineup {
  home: string[]
  away: string[]
}
interface Player {
  id: string
  name: string
}
export interface MatchEditData {
  goals: Goal[]
  lineup: Lineup
  cards: Card[]
}
interface EditMatchModalProps {
  match: MatchEditData
  players: Player[]
  onSave: (data: MatchEditData) => void
  onClose: () => void
}

/**
 * Modal para editar partido finalizado: goles y alineaciones
 * Props:
 * - match: datos del partido a editar
 * - players: lista de jugadores disponibles
 * - onSave: función para guardar cambios
 * - onClose: cerrar modal
 */
export default function EditMatchModal({ match, players, onSave, onClose }: EditMatchModalProps) {
  const [goals, setGoals] = useState<Goal[]>(match.goals)
  const [lineup, setLineup] = useState<Lineup>(match.lineup)
  const [cards, setCards] = useState<Card[]>(match.cards || [])
  // Editar tarjeta
  const handleCardChange = (idx: number, field: keyof Card, value: string | number) => {
    setCards((cards) => cards.map((c, i) => i === idx ? { ...c, [field]: value } : c))
  }
  // Agregar tarjeta
  const handleAddCard = () => setCards([...cards, { playerId: '', type: 'TA', minute: '' }])
  // Eliminar tarjeta
  const handleRemoveCard = (idx: number) => setCards(cards => cards.filter((_, i) => i !== idx))

  // Editar gol
  const handleGoalChange = (idx: number, field: keyof Goal, value: string | number) => {
    setGoals(goals => goals.map((g, i) => i === idx ? { ...g, [field]: value } : g))
  }
  // Agregar gol
  const handleAddGoal = () => setGoals([...goals, { playerId: '', minute: '', type: 'gol' }])
  // Eliminar gol
  const handleRemoveGoal = (idx: number) => setGoals(goals => goals.filter((_, i) => i !== idx))

  // Editar titular
  const handleLineupChange = (side: 'home' | 'away', idx: number, value: string) => {
    setLineup(lu => ({
      ...lu,
      [side]: lu[side].map((id, i) => i === idx ? value : id)
    }))
  }

  const handleSave = () => {
    onSave({ goals, lineup, cards })
  }

  return (
    <div className="modal-bg">
      <div className="modal">
        <h2>Editar Partido</h2>
        <h3>Goles</h3>
        {goals.map((g, idx) => (
          <div key={idx} className="goal-row">
            <select value={g.playerId} onChange={e => handleGoalChange(idx, 'playerId', e.target.value)}>
              <option value="">Selecciona jugador</option>
              {players.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <input type="number" value={g.minute} onChange={e => handleGoalChange(idx, 'minute', e.target.value)} placeholder="Min" />
            <select value={g.type} onChange={e => handleGoalChange(idx, 'type', e.target.value)}>
              <option value="gol">Gol</option>
              <option value="autogol">Autogol</option>
              <option value="penal">Penal</option>
            </select>
            <button onClick={() => handleRemoveGoal(idx)}>Eliminar</button>
          </div>
        ))}
        <button onClick={handleAddGoal}>Agregar Gol</button>

        <h3>Tarjetas (TA/TR)</h3>
        {cards.map((c, idx) => (
          <div key={idx} className="card-row">
            <select value={c.playerId} onChange={e => handleCardChange(idx, 'playerId', e.target.value)}>
              <option value="">Selecciona jugador</option>
              {players.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <input type="number" value={c.minute} onChange={e => handleCardChange(idx, 'minute', e.target.value)} placeholder="Min" />
            <select value={c.type} onChange={e => handleCardChange(idx, 'type', e.target.value)}>
              <option value="TA">TA</option>
              <option value="TR">TR</option>
            </select>
            <button onClick={() => handleRemoveCard(idx)}>Eliminar</button>
          </div>
        ))}
        <button onClick={handleAddCard}>Agregar Tarjeta</button>

        <h3>Alineación</h3>
        <div className="lineup-section">
          <div>
            <h4>Local</h4>
            {lineup.home.map((id, idx) => (
              <select key={idx} value={id} onChange={e => handleLineupChange('home', idx, e.target.value)}>
                <option value="">Selecciona jugador</option>
                {players.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            ))}
          </div>
          <div>
            <h4>Visita</h4>
            {lineup.away.map((id, idx) => (
              <select key={idx} value={id} onChange={e => handleLineupChange('away', idx, e.target.value)}>
                <option value="">Selecciona jugador</option>
                {players.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            ))}
          </div>
        </div>
        <div className="modal-actions">
          <button onClick={handleSave}>Guardar</button>
          <button onClick={onClose}>Cancelar</button>
        </div>
      </div>
    </div>
  )
}
