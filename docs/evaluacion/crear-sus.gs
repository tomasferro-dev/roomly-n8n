/**
 * Crea el cuestionario System Usability Scale (SUS) de la prueba del panel.
 * Pegar en https://script.google.com, guardar y ejecutar crearSus.
 */
function crearSus() {
  var form = FormApp.create('Roomly: cuestionario sobre el panel');
  form.setDescription('Marcá cuánto estás de acuerdo con cada frase sobre el panel que acabás de usar. ' +
    '1 = totalmente en desacuerdo, 5 = totalmente de acuerdo. No hay respuestas correctas.');
  form.setCollectEmail(false);

  form.addTextItem().setTitle('Tu código de participante').setHelpText('U01, U02…').setRequired(true);

  var items = [
    'S1. Creo que me gustaría usar este sistema con frecuencia.',
    'S2. Encontré el sistema innecesariamente complejo.',
    'S3. Pensé que el sistema era fácil de usar.',
    'S4. Creo que necesitaría la ayuda de una persona con conocimientos técnicos para poder usar este sistema.',
    'S5. Encontré que las distintas funciones del sistema estaban bien integradas.',
    'S6. Pensé que había demasiada inconsistencia en el sistema.',
    'S7. Imagino que la mayoría de las personas aprendería a usar este sistema muy rápidamente.',
    'S8. Encontré el sistema muy incómodo de usar.',
    'S9. Me sentí muy seguro o segura usando el sistema.',
    'S10. Necesité aprender muchas cosas antes de poder arreglarme con el sistema.'
  ];
  items.forEach(function (t) {
    form.addScaleItem().setTitle(t).setBounds(1, 5)
      .setLabels('Totalmente en desacuerdo', 'Totalmente de acuerdo').setRequired(true);
  });

  var hoja = SpreadsheetApp.create('Roomly – respuestas SUS');
  form.setDestination(FormApp.DestinationType.SPREADSHEET, hoja.getId());
  Logger.log('Link para el participante: ' + form.getPublishedUrl());
  Logger.log('Respuestas: ' + hoja.getUrl());
}
