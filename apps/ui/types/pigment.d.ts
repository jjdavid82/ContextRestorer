/**
 * Bind Pigment's theme type to MUI's `Theme` so `sx` / `styled` callbacks see
 * the real palette shape (per the `@mui/material-pigment-css` Next.js setup).
 */
import type { Theme } from '@mui/material/styles';

declare module '@mui/material-pigment-css' {
  interface ThemeArgs {
    theme: Theme;
  }
}
