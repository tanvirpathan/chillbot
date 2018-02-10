
'use strict';

/**
 * helper chillbot fulfillment logic
 */

process.env.DEBUG = 'actions-on-google:*';
const { DialogflowApp } = require('actions-on-google');
const functions = require('firebase-functions');
const firebaseAdmin = require('firebase-admin');

const firebaseConfig = functions.config().firebase;
firebaseAdmin.initializeApp(firebaseConfig);

/**
 * (Optional) Change this to the url of your custom hosting site
 * By default, it uses the Firebase hosting authDomain as the root url
 */
const CUSTOM_HOSTING_URL = '';

const HOSTING_URL = CUSTOM_HOSTING_URL || `https://${firebaseConfig.authDomain}`;

// Logging dependencies
const winston = require('winston');
winston.loggers.add('DEFAULT_LOGGER', {
  console: {
    colorize: true,
    label: 'Default logger',
    json: false,
    timestamp: true
  }
});
const logger = winston.loggers.get('DEFAULT_LOGGER');
const { logObject } = require('./utils');
logger.transports.console.level = 'debug';

const Ssml = require('./ssml').SSML;
const { sprintf } = require('sprintf-js');
const utils = require('./utils');

const { Themes, PROMPT_TYPES, AUDIO_TYPES, THEME_TYPES } = require('./themes');

const { generateSynonyms, getSynonyms } = require('./utils');

const MAIN_INTENT = 'chillbot.start';
const VALUE_INTENT = 'chillbot.choice.value';
const UNKNOWN_INTENT = 'chillbot.unknown';
const REPEAT_INTENT = 'chillbot.question.repeat';
const QUIT_INTENT = 'chillbot.quit';
const NEW_INTENT = 'chillbot.restart';
const ANSWERS_INTENT = 'chillbot.answers';
const ORDINAL_INTENT = 'chillbot.choice.ordinal';
const LAST_INTENT = 'chillbot.choice.last';
const PLAY_AGAIN_CONTEXT = 'restart';
const PLAY_AGAIN_YES_INTENT = 'chillbot.restart.yes';
const PLAY_AGAIN_NO_INTENT = 'chillbot.restart.no';
const DONE_CONTEXT = 'quit';
const DONE_YES_INTENT = 'chillbot.quit.yes';
const DONE_NO_INTENT = 'chillbot.quit.no';
const UNKNOWN_DEEPLINK_ACTION = 'deeplink.unknown';
const RAW_TEXT_ARGUMENT = 'raw_text';
const DISAGREE_INTENT = 'chillbot.answers.wrong';
const ANSWER_INTENT = 'chillbot.choice.answer';
const ANSWER_ARGUMENT = 'answer';
const MISTAKEN_INTENT = 'chillbot.mistaken';
const ITEM_INTENT = 'chillbot.choice.item';

const TTS_DELAY = '500ms';

const MAX_PREVIOUS_QUESTIONS = 100;
const SUGGESTION_CHIPS_MAX_TEXT_LENGTH = 25;
const SUGGESTION_CHIPS_MAX = 8;
const CHILLBOT_TITLE = 'The Fun helper chillbot';
const QUESTIONS_PER_chillbot = 1;

// Firebase data keys
const DATABASE_PATH_USERS = 'users/';
const DATABASE_PATH_DICTIONARY = 'dictionary/';
const DATABASE_QUESTIONS = 'questions';
const DATABASE_DATA = 'data';
const DATABASE_DRINKS = 'drinks';  
const DATABASE_PREVIOUS_QUESTIONS = 'previousQuestions';
const DATABASE_VISITS = 'visits';
const DATABASE_ANSWERS = 'answers';
const DATABASE_DICTIONARY = 'dictionary';
const DATABASE_FOLLOW_UPS = 'followUps';

const theme = THEME_TYPES.helper_TEACHER_THEME;
const AUDIO_BASE_URL = `${HOSTING_URL}/audio/`;

// Cloud Functions for Firebase entry point
exports.helperchillbot = functions.https.onRequest((request, response) => {
  logger.info(logObject('helper', 'handleRequest', {
    info: 'Handle request',
    headers: JSON.stringify(request.headers),
    body: JSON.stringify(request.body)
  }));

  const app = new DialogflowApp({request, response});
  const themes = new Themes();

  const userId = app.getUser().userId;
  const userIdKey = utils.encodeAsFirebaseKey(userId);
  let questions = [];
  let answers = [];
  let drinkDictionary = [];
  let followUps = [];
  let chillbotLength = QUESTIONS_PER_chillbot;
  let last = false;
  let middle = false;
  let ssmlNoInputPrompts;
  let questionPrompt;
  let selectedAnswers;
  let hasLastPrompt = false;
  let selectedAnswer;

  const hasScreen = app.hasSurfaceCapability(app.SurfaceCapabilities.SCREEN_OUTPUT);
  logger.info(logObject('helper', 'handleRequest', {
    info: 'Check screen capability',
    hasScreen: hasScreen
  }));

  // Get the no-input prompts from the VUI prompts
  const selectInputPrompts = () => {
    if (!ssmlNoInputPrompts) {
      // Convert no-input prompts to SSML
      ssmlNoInputPrompts = [];
      const noInputPrompts = [getRandomPrompt(PROMPT_TYPES.NO_INPUT_PROMPTS_1),
        getRandomPrompt(PROMPT_TYPES.NO_INPUT_PROMPTS_2),
        getRandomPrompt(PROMPT_TYPES.NO_INPUT_PROMPTS_3)];
      for (let i = 0; i < noInputPrompts.length; i++) {
        // Markup each no-input prompt as SSML
        const ssmlResponse = new Ssml();
        ssmlResponse.say(noInputPrompts[i]);
        ssmlNoInputPrompts.push(ssmlResponse.toString());
      }
    }
    return ssmlNoInputPrompts;
  };

  // Select a random audio track
  const getRandomAudio = (index) => {
    logger.debug(logObject('helper', 'getRandomAudio', {
      info: 'Get random audio',
      index: index
    }));
    return AUDIO_BASE_URL + themes.getRandomAudio(theme, index);
  };

  // Select a random prompt
  const getRandomPrompt = (index) => {
    const prompt = themes.getRandomPrompt(theme, index, app.data.lastPrompt);
    if (!hasLastPrompt) {
      hasLastPrompt = true;
      app.data.lastPrompt = prompt;
    }
    return prompt;
  };

  // Select new questions, avoiding the previous questions
  const selectQuestions = (questions) => {
    logger.debug(logObject('helper', 'post', {
      info: 'selectQuestions'
    }));
    if (!questions) {
      logger.error(logObject('helper', 'post', {
        info: 'selectQuestions: No questions.'
      }));
      return null;
    }
    if (chillbotLength > questions.length) {
      logger.error(logObject('helper', 'post', {
        info: 'selectQuestions: Not enough questions.',
        chillbotLength: chillbotLength,
        questions: questions.length
      }));
      chillbotLength = questions.length;
    }
    let previousQuestions = app.data.previousQuestions;
    logger.debug(logObject('helper', 'post', {
      previousQuestions: JSON.stringify(previousQuestions),
      questions: questions.length,
      chillbotLength: chillbotLength
    }));

    const selected = [];
    if (previousQuestions.length > MAX_PREVIOUS_QUESTIONS ||
        previousQuestions.length >= questions.length) {
      previousQuestions = previousQuestions.slice(chillbotLength, previousQuestions.length);
    }
    let i = 0;
    const checked = [];
    let index = 0;
    let previousIndex = 0;
    let found;
    // Select new questions, avoiding previous questions
    while (i < chillbotLength) {
      found = false;
      while (checked.length !== questions.length) {
        index = utils.getRandomNumber(0, questions.length - 1);
        if (selected.indexOf(index) === -1 && previousQuestions.indexOf(index) === -1) {
          selected.push(index);
          i++;
          found = true;
          break;
        }
        if (checked.indexOf(index) === -1) {
          checked.push(index);
        }
      }
      if (!found) {
        selected.push(previousQuestions[previousIndex++]);
        i++;
      }
    }

    logger.debug(logObject('helper', 'post', {
      selected: JSON.stringify(selected)
    }));
    previousQuestions = previousQuestions.concat(selected);
    app.data.previousQuestions = previousQuestions;
    firebaseAdmin.database().ref(DATABASE_PATH_USERS).child(userIdKey).update({
      [DATABASE_PREVIOUS_QUESTIONS]: previousQuestions
    });
    return selected;
  };

  // Select answers, using the index selected for the correct answer
  const selectAnswers = (correctIndex, answers) => {
    if (!answers) {
      logger.error(logObject('helper', 'post', {
        info: 'selectAnswers: No answers.'
      }));
      return null;
    }
    const selected = [];
    if (answers.length > 1) {
      const clonedAnswers = answers.slice(1);
      for (let i = 0; i < answers.length; i++) {
        if (i === correctIndex) {
          selected.push(answers[0]);
        } else {
          const index = utils.getRandomNumber(0, clonedAnswers.length - 1);
          selected.push(clonedAnswers[index]);
          clonedAnswers.splice(index, 1);
        }
      }
    } else {
      logger.error(logObject('helper', 'post', {
        info: 'selectAnswers: Not enough answers.',
        answers: answers.length
      }));
      return null;
    }
    logger.debug(logObject('helper', 'selectAnswers', {
      info: 'Selected answers',
      selected: selected
    }));
    return selected;
  };


  // Main welcome intent handler
  const mainIntent = (app, alternateWelcomePrompt) => {
    logger.info(logObject('helper', 'mainIntent', {
      info: 'Handling main intent'
    }));

    // Check if the user is new
    firebaseAdmin.database().ref(DATABASE_PATH_USERS).child(userIdKey)
      .once('value', (data) => {
        let newUser = true;
        let previousQuestions = [];
        if (data && data.val() && data.val()[DATABASE_VISITS]) {
          // Previously visited
          newUser = false;
          const visits = data.val()[DATABASE_VISITS] + 1;
          firebaseAdmin.database().ref(DATABASE_PATH_USERS).child(userIdKey).update({
            [DATABASE_VISITS]: visits
          });
          if (data.val()[DATABASE_PREVIOUS_QUESTIONS]) {
            previousQuestions = data.val()[DATABASE_PREVIOUS_QUESTIONS];
            logger.debug(logObject('helper', 'mainIntent', {
              info: 'Has previous questions',
              previousQuestions: JSON.stringify(previousQuestions)
            }));
          }
        } else {
          // First time user
          firebaseAdmin.database().ref(DATABASE_PATH_USERS).child(userIdKey).update({
            [DATABASE_VISITS]: 1
          });
        }
        app.data.previousQuestions = previousQuestions;

        startNewRound((error) => {
          if (error) {
            app.tell(error.message);
          } else {
            const ssmlResponse = new Ssml();
            //ssmlResponse.audio(getRandomAudio(AUDIO_TYPES.AUDIO_chillbot_INTRO), 'chillbot intro');

            ssmlResponse.say(getRandomPrompt(PROMPT_TYPES.INTRODUCTION_PROMPTS));

            // ssmlResponse.say(getRandomPrompt(PROMPT_TYPES.INTRODUCTION_PROMPTS));
            // ssmlResponse.say(getRandomPrompt(PROMPT_TYPES.FIRST_ROUND_PROMPTS));
            ssmlResponse.pause(TTS_DELAY);
            askQuestion(ssmlResponse, questionPrompt, selectedAnswers);
          }
        });
      });
  };

  // Utility to create the prompt to ask a question
  const askQuestion = (ssmlResponse, question, answers) => {
    logger.debug(logObject('helper', 'askQuestion', {
      info: 'askQuestion'
    }));
    if (!question || !answers) {
      logger.error(logObject('helper', 'askQuestion', {
        info: 'askQuestion: No questions',
        question: question,
        answers: answers
      }));
      ssmlResponse.say('No more questions.');
      return;
    }

    const askQuestionAudioOnly = () => {
      logger.debug(logObject('helper', 'askQuestion', {
        info: 'askQuestionAudioOnly'
      }));
      // Check if true/false question
      if (isTrueFalseQuestion(answers) && question) {
        app.setContext(TRUE_FALSE_CONTEXT);
        ssmlResponse.say(sprintf(getRandomPrompt(PROMPT_TYPES.TRUE_FALSE_PROMPTS), question));
        ssmlResponse.pause(TTS_DELAY);
        // ssmlResponse.audio(getRandomAudio(AUDIO_TYPES.AUDIO_DING), 'ding');
        app.ask(ssmlResponse.toString(), selectInputPrompts());
        return;
      }
      if (question) {
        ssmlResponse.say(question);
      }
      // Format the answers
      for (let i = 0; i < answers.length; i++) {
        const synonyms = getSynonyms(answers[i]);
        if (synonyms && synonyms.length > 0) {
          const synonym = synonyms[0].trim();
          ssmlResponse.pause(TTS_DELAY);
          if (i === answers.length - 2) {
            ssmlResponse.say(`${synonym}, `);
          } else if (i === answers.length - 1) {
            ssmlResponse.say(` or ${synonym}.`);
          } else {
            ssmlResponse.say(`${synonym}, `);
          }
        }
      }
      ssmlResponse.pause(TTS_DELAY);
      // ssmlResponse.audio(getRandomAudio(AUDIO_TYPES.AUDIO_DING), 'ding');
      app.ask(ssmlResponse.toString(), selectInputPrompts());
    };
    if (hasScreen) {
      logger.debug(logObject('helper', 'askQuestion', {
        info: 'hasScreen'
      }));
      // Use two chat bubbles for intro and question
      // Use suggestion chips for answers
      const questionSsmlResponse = new Ssml();
      if (isTrueFalseQuestion(answers) && question) {
        app.setContext(TRUE_FALSE_CONTEXT);
        questionSsmlResponse.say(sprintf(getRandomPrompt(PROMPT_TYPES.TRUE_FALSE_PROMPTS), question));
        questionSsmlResponse.pause(TTS_DELAY);
        // questionSsmlResponse.audio(getRandomAudio(AUDIO_TYPES.AUDIO_DING), 'ding');
        app.ask(app
          .buildRichResponse()
          .addSimpleResponse(ssmlResponse.toString())
          .addSimpleResponse(questionSsmlResponse.toString())
          .addSuggestions([utils.TRUE, utils.FALSE]));
        return;
      }
      const chips = [];
      // Use a list to show the answers if they don't meet the
      // suggestion chips requirements:
      // https://developers.google.com/actions/app/responses#suggestion-chip
      let useList = answers.length > SUGGESTION_CHIPS_MAX;
      for (let i = 0; i < answers.length; i++) {
        let value = answers[i];
        const synonyms = getSynonyms(answers[i]);
        if (synonyms && synonyms.length > 0) {
          value = synonyms[0].trim();
        }
        if (value.length > SUGGESTION_CHIPS_MAX_TEXT_LENGTH) {
          useList = true;
        }
        chips.push(value);
      }
      logger.debug(logObject('helper', 'askQuestion', {
        info: 'hasScreen',
        chips: JSON.stringify(chips)
      }));
      if (chips.length === 0) {
        askQuestionAudioOnly();
        return;
      }
      if (question) {
        questionSsmlResponse.say(question);
      }
      questionSsmlResponse.pause(TTS_DELAY);
      // questionSsmlResponse.audio(getRandomAudio(AUDIO_TYPES.AUDIO_DING), 'ding');
      if (useList) {
        logger.debug(logObject('helper', 'askQuestion', {
          info: 'askQuestion: list'
        }));
        const list = app.buildList();
        for (let i = 0; i < chips.length; i++) {
          const chip = chips[i];
          list.addItems(app.buildOptionItem(chip).setTitle(chip));
        }
        const richResponse = app.buildRichResponse()
          .addSimpleResponse(ssmlResponse.toString())
          .addSimpleResponse(questionSsmlResponse.toString());
        logger.debug(logObject('helper', 'askQuestion', {
          info: 'askQuestion: list',
          richResponse: JSON.stringify(richResponse),
          list: JSON.stringify(list)
        }));
        app.askWithList(richResponse, list);
      } else {
        logger.debug(logObject('helper', 'askQuestion', {
          info: 'askQuestion: suggestion chips'
        }));
        app.ask(app
          .buildRichResponse()
          .addSimpleResponse(ssmlResponse.toString())
          .addSimpleResponse(questionSsmlResponse.toString())
          .addSuggestions(chips));
      }
    } else {
      logger.debug(logObject('helper', 'askQuestion', {
        info: 'No screen'
      }));
      askQuestionAudioOnly();
    }
  };

  // For ordinal responses, check that answer is in range
  const isValidAnswer = (answer, answers) => {

    // const drinkChoice = app.getArgument(ANSWER_ARGUMENT).trim();
    // app.tell('If i\'m not mistaken, you chose ' + drinkChoice);

    return (answer && !isNaN(parseInt(answer)) &&
      parseInt(answer) < (answers.length + 1) && parseInt(answer) > 0);
  };

  // Generate the response for the next question
  const nextQuestion = (app, ssmlResponse) => {
    const sessionQuestions = app.data.sessionQuestions;
    const answers = app.data.sessionAnswers;
    chillbotLength = parseInt(app.data.chillbotLength);
    let currentQuestion = parseInt(app.data.currentQuestion);
    const score = parseInt(app.data.score);

    // Last question
    if (currentQuestion === chillbotLength - 1) {
      // ssmlResponse.audio(getRandomAudio(AUDIO_TYPES.AUDIO_ROUND_ENDED), 'round ended');
      // ssmlResponse.say(getRandomPrompt(PROMPT_TYPES.chillbot_OVER_PROMPTS_1));
      // ssmlResponse.say(getRandomPrompt(PROMPT_TYPES.chillbot_OVER_PROMPTS_2));
      // ssmlResponse.audio(getRandomAudio(AUDIO_TYPES.AUDIO_CALCULATING), 'calculating');
      // ssmlResponse.pause(TTS_DELAY);
      // if (score === chillbotLength) {
      //   ssmlResponse.say(sprintf(getRandomPrompt(PROMPT_TYPES.ALL_CORRECT_PROMPTS), score));
      // } else if (score === 0) {
      //   ssmlResponse.say(sprintf(getRandomPrompt(PROMPT_TYPES.NONE_CORRECT_PROMPTS), score));
      // } else {
      //   ssmlResponse.say(sprintf(getRandomPrompt(PROMPT_TYPES.SOME_CORRECT_PROMPTS), score));
      // }
      ssmlResponse.say('Would you like to look for something else?');
      app.setContext(PLAY_AGAIN_CONTEXT);
      if (hasScreen) {
        app.ask(app
          .buildRichResponse()
          .addSimpleResponse(ssmlResponse.toString())
          .addSuggestions([utils.YES, utils.NO]));
      } else {
        app.ask(ssmlResponse.toString(), selectInputPrompts());
      }
      persistScore();
    } else {
      // Not the last question
      currentQuestion++;
      if (currentQuestion === chillbotLength - 1) {
        ssmlResponse.say(getRandomPrompt(PROMPT_TYPES.FINAL_ROUND_PROMPTS));
      } else if (currentQuestion % 2 === 1) {
        ssmlResponse.say(sprintf(getRandomPrompt(PROMPT_TYPES.ROUND_PROMPTS), (currentQuestion + 1)));
      } else if (app.data.correct) {
        ssmlResponse.say(getRandomPrompt(PROMPT_TYPES.NEXT_QUESTION_PROMPTS));
      } else {
        ssmlResponse.say(getRandomPrompt(PROMPT_TYPES.QUESTION_PROMPTS));
      }
      ssmlResponse.pause(TTS_DELAY);
      const questionPrompt = sessionQuestions[currentQuestion];

      let correctIndex = 0;
      let selectedAnswers = [];
      const selectedQuestionAnswers = answers[currentQuestion];
      if (isTrueFalseQuestion(selectedQuestionAnswers)) {
        selectedAnswers = selectedQuestionAnswers.slice(0);
      } else {
        correctIndex = utils.getRandomNumber(0, selectedQuestionAnswers.length - 1);
        selectedAnswers = selectAnswers(correctIndex, selectedQuestionAnswers);
      }
      if (selectedAnswers) {
        app.data.selectedAnswers = selectedAnswers;
        app.data.correctAnswer = correctIndex;
        app.data.questionPrompt = questionPrompt;
        app.data.fallbackCount = 0;
        app.data.currentQuestion = currentQuestion;
        app.data.score = score;
        askQuestion(ssmlResponse, questionPrompt, selectedAnswers);
      } else {
        app.tell('There is a problem with the answers.');
      }
    }
  };

  // The user provided an ordinal answer
  const valueIntent = (app, choice, ssml) => {
    logger.info(logObject('helper', 'valueIntent', {
      info: 'Handle value intent',
      rawInput: app.getRawInput(),
      choice: choice
    }));

    const selectedAnswers = app.data.selectedAnswers;
    const sessionFollowUps = app.data.sessionFollowUps;
    const currentQuestion = parseInt(app.data.currentQuestion);
    const correctAnswer = parseInt(app.data.correctAnswer);
    chillbotLength = parseInt(app.data.chillbotLength);
    let score = parseInt(app.data.score);

    let number;

    // Answers in mathematical format are matched to values by Dialogflow
    // Handle as special case by comparing raw input with expected value
    let found = false;
    if (!choice) {
      for (let i = 0; i < selectedAnswers.length; i++) {
        const synonyms = getSynonyms(selectedAnswers[i]);
        if (synonyms) {
          for (let j = 0; j < synonyms.length; j++) {
            if (utils.compareStrings(synonyms[j], app.getRawInput())) {
              number = i + 1;
              found = true;
              break;
            }
          }
        }
        if (found) {
          break;
        }
      }
    }

    // Value intent is reused for various intents that pass in their arguments
    // using different argument names
    if (!number) {
      number = app.getArgument('number');
    }
    if (!number) {
      number = app.getArgument('any');
    }
    if (!number) {
      number = app.getArgument('ordinal');
    }
    if (!number && last) {
      number = selectedAnswers.length.toString();
      last = false;
    }
    if (!number && middle) {
      number = (Math.floor(selectedAnswers.length / 2) + 1).toString();
      middle = false;
    }
    if (!number) {
      number = choice;
    }
    logger.debug(logObject('helper', 'valueIntent', {
      info: 'Guessed number',
      number: number
    }));

    let ssmlResponse = new Ssml();
    if (ssml) {
      ssmlResponse = ssml;
    }

    const synonyms = getSynonyms(selectedAnswers[correctAnswer]);
    if (isValidAnswer(number, selectedAnswers)) {
      logger.debug(logObject('helper', 'valueIntent', {
        info: 'Answer is valid',
        correctAnswer: correctAnswer
      }));
      const answer = parseInt(number);
      if ((correctAnswer + 1) === answer) {
        score++;
        app.data.correct = true;

      } else {
        app.data.correct = false;
        //ssmlResponse.audio(getRandomAudio(AUDIO_TYPES.AUDIO_INCORRECT), 'incorrect');
      }

      let voiceAnswer = app.getRawInput();
      let realAnswer = "";

      if (voiceAnswer == "Diet Coke") {
        realAnswer = "dietCoke";
      } else if (voiceAnswer == "Coca Cola" || voiceAnswer == "Coca-Cola" || voiceAnswer == "Coca-cola") {
        realAnswer = "coke";
      } else if (voiceAnswer == "Perrier") {
        realAnswer = "perrier";
      }

      let weHaveIt = app.data.drinkDictionary[realAnswer];


      if (weHaveIt) {
        // TODO SOUND
        // ssmlResponse.audio(getRandomAudio(AUDIO_TYPES.AUDIO_DING), 'ding');
        ssmlResponse.say('We have some ' + voiceAnswer + getRandomPrompt(PROMPT_TYPES.FEELING_LUCKY_PROMPTS));
      } else {
        ssmlResponse.say('We don\'t have any ' + voiceAnswer + getRandomPrompt(PROMPT_TYPES.FINAL_ROUND_PROMPTS)); //". I\'m so so sorry. I feel personally responsible for this. Please don't hold it against me.");
      }
      // const answer = parseInt(number);

      app.data.score = score;
      nextQuestion(app, ssmlResponse);
    } else {
      unknownIntent(app, true);
    }
  };

  // Default fallback intent handler
  const unknownIntent = (app, otherIntentTriggered) => {
    logger.info(logObject('helper', 'unknownIntent', {
      info: 'Handling unknown intent',
      rawInput: app.getRawInput(),
      otherIntentTriggered: otherIntentTriggered
    }));

    // Keep track of how many times the user provides unknown input sequentially
    let fallbackCount = 0;
    if (app.data.fallbackCount === undefined) {
      fallbackCount = 0;
    } else {
      fallbackCount = parseInt(app.data.fallbackCount);
    }
    fallbackCount++;
    app.data.fallbackCount = fallbackCount;
    const selectedAnswers = app.data.selectedAnswers;

    // Check if the answer is amongst all the the answers for any of the questions
    const handleDictionaryInput = () => {
      // Provide three prompts before ending chillbot
      const ssmlResponse = new Ssml();
      const correctAnswer = parseInt(app.data.correctAnswer);
      const synonyms = getSynonyms(selectedAnswers[correctAnswer]);
      app.data.correct = false;
      ssmlResponse.audio(getRandomAudio(AUDIO_TYPES.AUDIO_INCORRECT), 'incorrect');
      if (synonyms && synonyms.length > 0) {
        ssmlResponse.say(`${getRandomPrompt(PROMPT_TYPES.WRONG_ANSWER_FOR_QUESTION_PROMPTS)} ${
          sprintf(getRandomPrompt(PROMPT_TYPES.CORRECT_ANSWER_ONLY_PROMPTS), synonyms[0])}`);
      } else {
        ssmlResponse.say(getRandomPrompt(PROMPT_TYPES.WRONG_ANSWER_FOR_QUESTION_PROMPTS));
      }
      nextQuestion(app, ssmlResponse);
    };

    const handleNonDictionaryInput = (inDictionary) => {
      // Provide three prompts before ending chillbot
      const ssmlResponse = new Ssml();
      // Provide different response depending on the fallback count
      if (fallbackCount === 1) {
        ssmlResponse.say(getRandomPrompt(PROMPT_TYPES.RAPID_REPROMPTS));
        app.ask(ssmlResponse.toString(), selectInputPrompts());
      } else if (fallbackCount === 2) {
        app.setContext(DONE_CONTEXT);
        ssmlResponse.say(getRandomPrompt(PROMPT_TYPES.FALLBACK_PROMPT_1));
        if (hasScreen) {
          app.ask(app
            .buildRichResponse()
            .addSimpleResponse(ssmlResponse.toString())
            .addSuggestions([utils.YES, utils.NO]));
        } else {
          app.ask(ssmlResponse.toString(), selectInputPrompts());
        }
      } else {
        ssmlResponse.say(getRandomPrompt(PROMPT_TYPES.FALLBACK_PROMPT_2));
        ssmlResponse.audio(getRandomAudio(AUDIO_TYPES.AUDIO_chillbot_OUTRO), 'chillbot ending');
        app.tell(ssmlResponse.toString());
      }
    };

    // Try fuzzy and partial matching against the answers
    const rawInput = app.getRawInput().trim();
    if (!otherIntentTriggered && selectedAnswers) {
      const parts = rawInput.split(utils.SPACE);
      for (let i = 0; i < selectedAnswers.length; i++) {
        const synonyms = getSynonyms(selectedAnswers[i]);
        if (synonyms) {
          for (let j = 0; j < synonyms.length; j++) {
            if (utils.fuzzyMatch(synonyms[j], rawInput)) {
              logger.debug(logObject('helper', 'unknownIntent', {
                info: 'Fuzzy matched',
                answer: i + 1
              }));
              valueIntent(app, i + 1, null);
              return;
            }
            // Check for partial matches of words
            for (let k = 0; k < parts.length; k++) {
              if (utils.compareStrings(parts[k], synonyms[j])) {
                logger.debug(logObject('helper', 'unknownIntent', {
                  info: 'Partial match',
                  answer: i + 1
                }));
                valueIntent(app, i + 1, null);
                return;
              }
            }
          }
        }
      }
    }

    // Get the dictionary list of all possible answers
    firebaseAdmin.database().ref(`${DATABASE_DATA}/${DATABASE_PATH_DICTIONARY
        }${utils.encodeAsFirebaseKey(app.getRawInput().toLowerCase())}`)
      .once('value', (data) => {
        if (data && data.val()) {
          handleDictionaryInput();
        } else {
          handleNonDictionaryInput();
        }
      }, (error) => {
        if (error) {
          handleNonDictionaryInput();
        }
      });
  };

  // Handle user repeat request
  const repeatIntent = (app) => {
    logger.info(logObject('helper', 'repeatIntent', {
      info: 'Handling repeat intent',
      rawInput: app.getRawInput()
    }));

    app.data.fallbackCount = 0;
    const ssmlResponse = new Ssml();
    ssmlResponse.say(getRandomPrompt(PROMPT_TYPES.REPEAT_PROMPTS));
    askQuestion(ssmlResponse, app.data.questionPrompt, app.data.selectedAnswers);
  };

  // Handle user help request
  const helpIntent = (app) => {
    logger.info(logObject('helper', 'helpIntent', {
      info: 'Handling help intent',
      rawInput: app.getRawInput()
    }));

    app.data.fallbackCount = 0;
    app.setContext(HELP_CONTEXT);
    const ssmlResponse = new Ssml();
    ssmlResponse.say(sprintf(getRandomPrompt(PROMPT_TYPES.HELP_PROMPTS), app.data.chillbotLength));
    if (hasScreen) {
      app.ask(app
        .buildRichResponse()
        .addSimpleResponse(ssmlResponse.toString())
        .addSuggestions([utils.YES, utils.NO]));
    } else {
      app.ask(ssmlResponse.toString(), selectInputPrompts());
    }
  };

  // Handle user quit request
  const quitIntent = (app) => {
    logger.info(logObject('helper', 'quitIntent', {
      info: 'Handling quit intent',
      rawInput: app.getRawInput()
    }));

    const ssmlResponse = new Ssml();
    ssmlResponse.say(sprintf(getRandomPrompt(PROMPT_TYPES.END_PROMPTS), app.data.score, app.data.chillbotLength));
    ssmlResponse.audio(getRandomAudio(AUDIO_TYPES.AUDIO_chillbot_OUTRO), 'chillbot ending');
    app.tell(ssmlResponse.toString());
  };

  // Handle user play again YES response (already in play again context)
  const playAgainYesIntent = (app) => {
    logger.info(logObject('helper', 'playAgainYesIntent', {
      info: 'Handling play again yes intent',
      rawInput: app.getRawInput()
    }));

    startNewRound((error) => {
      if (error) {
        app.tell(error.message);
      } else {
        const ssmlResponse = new Ssml();
        ssmlResponse.say(getRandomPrompt(PROMPT_TYPES.RE_PROMPT));
        ssmlResponse.pause(TTS_DELAY);
        askQuestion(ssmlResponse, questionPrompt, selectedAnswers);
      }
    });
  };

  // Handle user play again NO response (already in play again context)
  const playAgainNoIntent = (app) => {
    logger.info(logObject('helper', 'playAgainNoIntent', {
      info: 'Handling play again no intent',
      rawInput: app.getRawInput()
    }));

    const ssmlResponse = new Ssml();
    ssmlResponse.say(getRandomPrompt(PROMPT_TYPES.QUIT_PROMPTS));
    ssmlResponse.audio(getRandomAudio(AUDIO_TYPES.AUDIO_chillbot_OUTRO), 'chillbot ending');
    app.tell(ssmlResponse.toString());
  };

  // Handle user done YES response (already in done context)
  const doneYesIntent = (app) => {
    logger.info(logObject('helper', 'doneYesIntent', {
      info: 'Handling done yes intent',
      rawInput: app.getRawInput()
    }));

    const ssmlResponse = new Ssml();
    ssmlResponse.say(getRandomPrompt(PROMPT_TYPES.QUIT_PROMPTS));
    ssmlResponse.audio(getRandomAudio(AUDIO_TYPES.AUDIO_chillbot_OUTRO), 'chillbot ending');
    app.tell(ssmlResponse.toString());
  };

  // Handle user answers request
  const answersIntent = (app) => {

        const drinkChoice = app.getArgument(ANSWER_ARGUMENT).trim();
    app.tell('If i\'m not mistaken, you chose ' + drinkChoice);

    logger.info(logObject('helper', 'answersIntent', {
      info: 'Handling answers intent',
      rawInput: app.getRawInput()
    }));

    const ssmlResponse = new Ssml();
    app.data.fallbackCount = 0;

    ssmlResponse.say(`${getRandomPrompt(PROMPT_TYPES.REPEAT_PROMPTS)} `);
    askQuestion(ssmlResponse, app.data.questionPrompt, app.data.selectedAnswers);
  };

  // Handle user ordinal response for last answer
  const lastIntent = (app) => {

    const drinkChoice = app.getArgument(ANSWER_ARGUMENT).trim();
    app.tell('If i\'m not mistaken, you chose ' + drinkChoice);

    logger.info(logObject('helper', 'lastIntent', {
      info: 'Handling last intent',
      rawInput: app.getRawInput()
    }));

    last = true;
    valueIntent(app, null, null);
  };

  // Handle user answer response
  const answerIntent = (app) => {

    // const drinkChoice = app.getArgument(ANSWER_ARGUMENT).trim();
    // app.tell('If i\'m not mistaken, you chose ' + drinkChoice);

    // app.data.selectedAnswer = app.getRawInput();

    logger.info(logObject('helper', 'answerIntent', {
      info: 'Handling answer intent',
      rawInput: app.getRawInput()
    }));

    let answer = 0;
    const handleAnswer = (answer) => {
      logger.debug(logObject('helper', 'answerIntent', {
        info: 'Handling answer intent',
        answer: answer
      }));
      valueIntent(app, answer, null);
    };

    // Catch the answer being repeated
    const contexts = app.getContexts();
    if (contexts) {
      for (let i = 0; i < contexts.length; i++) {
        const context = contexts[i];
        if (context.name === PLAY_AGAIN_CONTEXT) {
          if (app.data.fallbackCount > 0) {
            doneYesIntent(app);
          } else if (app.data.rawInput === app.getRawInput()) {
            app.data.fallbackCount++;
            app.setContext(DONE_CONTEXT);
            const ssmlResponse = new Ssml();
            ssmlResponse.say(getRandomPrompt(PROMPT_TYPES.FALLBACK_PROMPT_1));
            if (hasScreen) {
              app.ask(app
                .buildRichResponse()
                .addSimpleResponse(ssmlResponse.toString())
                .addSuggestions([utils.YES, utils.NO]));
            } else {
              app.ask(ssmlResponse.toString(), selectInputPrompts());
            }
            return;
          }
        } else if (context.name === DONE_CONTEXT) {
          doneYesIntent(app);
          return;
        }
      }
    }
    app.data.rawInput = app.getRawInput();

    // Check if answer value is in the expected list of synonyms for the answer
    const choice = app.getArgument(ANSWER_ARGUMENT).trim();
    const selectedAnswers = app.data.selectedAnswers;

    app.tell('If i\'m not mistaken, you chose ' + app.getRawInput());

    let answered = false;
    if (selectedAnswers) {
      const correctAnswer = parseInt(app.data.correctAnswer);
      const synonyms = getSynonyms(selectedAnswers[correctAnswer]);
      if (utils.compareStrings(app.getRawInput(), synonyms[0])) {
        answered = true;
        answer = correctAnswer + 1;
      } else {
        for (let i = 0; i < selectedAnswers.length; i++) {
          const synonyms = getSynonyms(selectedAnswers[i]);
          if (synonyms && synonyms.length > 0) {
            for (let j = 0; j < synonyms.length; j++) {
              if (utils.compareStrings(synonyms[j], choice)) {
                answered = true;
                answer = i + 1;
                break;
              }
            }
            if (answered) {
              break;
            }
          }
        }
      }
    }
    if (answered) {
      handleAnswer(answer);
    } else {
      // Could be the entity key of another answer.
      // For each synonym of the entity key for the user's answer,
      // check if it matches the synonyms of the expected answer.
      generateSynonyms([choice], (err, results) => {
        if (!err) {
          const entities = getSynonyms(results[0]);
          if (entities && selectedAnswers) {
            for (let i = 0; i < selectedAnswers.length; i++) {
              const synonyms = getSynonyms(selectedAnswers[i]);
              if (synonyms) {
                for (let j = 1; j < synonyms.length; j++) {
                  for (let k = 1; k < entities.length; k++) {
                    if (utils.compareStrings(synonyms[j], entities[k])) {
                      answered = true;
                      answer = i + 1;
                      break;
                    }
                  }
                  if (answered) {
                    break;
                  }
                }
              }
              if (answered) {
                break;
              }
            }
          }
        }
        if (!answered) {
          unknownIntent(app, true);
        } else {
          handleAnswer(answer);
        }
      });
    }
  };

  // Handle the mistaken user response
  const mistakenIntent = (app) => {
    logger.info(logObject('helper', 'mistakenIntent', {
      info: 'Handling mistaken intent',
      rawInput: app.getRawInput()
    }));

    const ssmlResponse = new Ssml();
    app.data.fallbackCount = 0;

    ssmlResponse.say(getRandomPrompt(PROMPT_TYPES.PLAY_AGAIN_QUESTION_PROMPTS));
    askQuestion(ssmlResponse, app.data.questionPrompt, app.data.selectedAnswers);
  };

  const actionMap = new Map();
  actionMap.set(MAIN_INTENT, mainIntent);
  actionMap.set(VALUE_INTENT, valueIntent);
  actionMap.set(UNKNOWN_INTENT, unknownIntent);
  actionMap.set(REPEAT_INTENT, repeatIntent);
  actionMap.set(HELP_INTENT, helpIntent);
  actionMap.set(QUIT_INTENT, quitIntent);
  actionMap.set(PLAY_AGAIN_YES_INTENT, playAgainYesIntent);
  actionMap.set(PLAY_AGAIN_NO_INTENT, playAgainNoIntent);
  actionMap.set(DONE_YES_INTENT, doneYesIntent);
  actionMap.set(DONE_NO_INTENT, doneNoIntent);
  actionMap.set(NEW_INTENT, playAgainYesIntent);
  actionMap.set(HELP_YES_INTENT, helpYesIntent);
  actionMap.set(HELP_NO_INTENT, doneYesIntent);
  actionMap.set(DONT_KNOW_INTENT, dontKnowIntent);
  actionMap.set(ORDINAL_INTENT, valueIntent);
  actionMap.set(ANSWERS_INTENT, answersIntent);
  actionMap.set(LAST_INTENT, lastIntent);
  actionMap.set(MIDDLE_INTENT, middleIntent);
  actionMap.set(UNKNOWN_DEEPLINK_ACTION, unhandledDeeplinksIntent);
  actionMap.set(HINT_INTENT, hintIntent);
  actionMap.set(DISAGREE_INTENT, disagreeIntent);
  actionMap.set(ANSWER_INTENT, answerIntent);
  actionMap.set(MISTAKEN_INTENT, mistakenIntent);
  actionMap.set(FEELING_LUCKY_INTENT, feelingLuckyIntent);
  actionMap.set(TRUE_INTENT, trueIntent);
  actionMap.set(FALSE_INTENT, falseIntent);
  actionMap.set(ITEM_INTENT, listIntent);

  app.handleRequest(actionMap);
});
