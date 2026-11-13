/**
 * Crea el formulario de recolección de la evaluación (TARJETAS.md).
 * Pegar en https://script.google.com (Proyecto nuevo), guardar y ejecutar
 * crearFormulario. El enlace para compartir aparece en el registro de ejecución.
 */
function crearFormulario() {
  var form = FormApp.create('Roomly: ¿cómo le escribirías a un hotel?');
  form.setDescription(
    'Estamos evaluando un asistente que atiende reservas de un hotel por WhatsApp. ' +
    'No vas a hablar con el asistente: solo vas a escribir mensajes.\n\n' +
    'Imaginá que HOY ES MARTES 1 DE DICIEMBRE DE 2026. En cada pregunta hay una situación. ' +
    'Escribí el mensaje que le mandarías al hotel por WhatsApp, con tus palabras, como escribís siempre ' +
    '(abreviaturas, sin tildes, lo que te salga). No copies el texto de la situación.\n\n' +
    'Usá nombres inventados. No pongas teléfonos, documentos ni correos reales. ' +
    'Te lleva unos 10 minutos. ¡Gracias!'
  );
  form.setCollectEmail(false);
  // setRequireLogin sólo existe en cuentas de Google Workspace; en una cuenta
  // personal el formulario ya se puede responder sin iniciar sesión.
  form.setLimitOneResponsePerUser(false);
  form.setShowLinkToRespondAgain(false);
  form.setConfirmationMessage('¡Gracias! Tus mensajes quedaron registrados.');

  form.addTextItem()
    .setTitle('Tu código de participante')
    .setHelpText('Te lo damos nosotros: P01, P02…')
    .setRequired(true);

  form.addCheckboxItem()
    .setTitle('Consentimiento')
    .setChoiceValues(['Confirmo que no participé del desarrollo de Roomly, que soy mayor de edad y que acepto que mis mensajes se usen, sin datos personales, en la evaluación de un trabajo final.'])
    .setRequired(true);

  var tarjetas = [
    'C1. Querés reservar para vos y tu pareja, del viernes 18 al domingo 20 de diciembre, y pagar una seña. Pedilo en un solo mensaje, con todos los datos y un nombre inventado.',
    'C2. Viajás con tres amigos (cuatro personas en total) del 27 al 30 de diciembre y querés pagar todo de una vez. Pedí la reserva con todos los datos en un solo mensaje, con un nombre inventado.',
    'P1. Querés saber si hay lugar para el fin de semana del 12 de diciembre, pero todavía no sabés cuántos van a ir.',
    'P2. Querés reservar una habitación para dos personas, pero todavía no tenés las fechas decididas.',
    'R1. Querés ir este fin de semana, sábado y domingo, vos solo o sola.',
    'R2. Querés llegar el viernes que viene y quedarte tres noches, con otra persona.',
    'G1. Ya tenés la reserva RML-4821 y querés irte un día más tarde de lo que habías reservado.',
    'G2. Ya tenés la reserva RML-3307 y no vas a poder viajar: querés cancelarla.',
    'O1. Antes de reservar, querés saber si aceptan mascotas.',
    'O2. Recién encontrás el WhatsApp del hotel. Escribí lo primero que le mandarías.'
  ];
  tarjetas.forEach(function (t) {
    form.addParagraphTextItem()
      .setTitle(t)
      .setHelpText('Escribí el mensaje tal como lo mandarías por WhatsApp.')
      .setRequired(true);
  });

  var hoja = SpreadsheetApp.create('Roomly – respuestas del formulario');
  form.setDestination(FormApp.DestinationType.SPREADSHEET, hoja.getId());

  Logger.log('Link para compartir: ' + form.getPublishedUrl());
  Logger.log('Editar: ' + form.getEditUrl());
  Logger.log('Respuestas: ' + hoja.getUrl());
}
