export type ToolGatesState = { computerUse: boolean; browserTools: boolean };
export type ToolGatesAvailable = { computerUse: boolean; browserTools: boolean };

export interface ToolGatesService {
  get(): Promise<{ state: ToolGatesState; available: ToolGatesAvailable }>;
  getSync(): { state: ToolGatesState };
  set(input: Partial<ToolGatesState>): Promise<ToolGatesState>;
}
