import 'dotenv/config';
import { ejecutarAvailabilityJob } from '../jobs/availability.job';

async function main() {
  console.log("🚀 Iniciando limpieza MANUAL de TODOS los pisos (sin límite de 48h)...");
  // Pasamos 'true' para forzar que revise toda la base de datos
  await ejecutarAvailabilityJob(true);
  console.log("✅ Limpieza completada. Revisa el resumen arriba.");
  process.exit(0);
}

main().catch(console.error);
