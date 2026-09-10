export const DECK = ['0', '1', '2', '3', '5', '8', '13', '21', '?', '☕'] as const;

export interface Participant {
  id: string;
  name: string;
  voted: boolean;
  vote: string | null;
}

export interface RoomState {
  revealed: boolean;
  participants: Participant[];
}
