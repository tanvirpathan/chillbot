package com.inbiaf.android.chillbot.classifier;

import android.app.Activity;
import android.content.res.AssetFileDescriptor;
import android.graphics.Bitmap;
import android.os.SystemClock;
import android.util.Log;

import com.inbiaf.android.chillbot.Drinks;

import org.tensorflow.lite.Interpreter;

import java.io.BufferedReader;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.MappedByteBuffer;
import java.nio.channels.FileChannel;
import java.util.AbstractMap;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;

/**
 * Classifies images with Tensorflow Lite.
 */
public class ImageClassifier {

    /**
     * Tag for the {@link Log}.
     */
    private static final String TAG = "TfLiteCameraDemo";

    /**
     * Name of the model file stored in Assets.
     */
    private static final String MODEL_PATH = "chill-bot.lite";

    /**
     * Name of the label file stored in Assets.
     */
    private static final String LABEL_PATH = "labels.txt";

    /**
     * Number of results to show in the UI.
     */
    private static final int RESULTS_TO_SHOW = 3;

    /**
     * Dimensions of inputs.
     */
    private static final int DIM_BATCH_SIZE = 1;

    private static final int DIM_PIXEL_SIZE = 3;

    static final int DIM_IMG_SIZE_X = 224;
    static final int DIM_IMG_SIZE_Y = 224;

    private static final int IMAGE_MEAN = 128;
    private static final float IMAGE_STD = 128.0f;


    /* Preallocated buffers for storing image data in. */
    private int[] intValues = new int[DIM_IMG_SIZE_X * DIM_IMG_SIZE_Y];

    /**
     * An instance of the driver class to run model inference with Tensorflow Lite.
     */
    private Interpreter tflite;

    /**
     * Labels corresponding to the output of the vision model.
     */
    private List<String> labelList;

    /**
     * A ByteBuffer to hold image data, to be feed into Tensorflow Lite as inputs.
     */
    private ByteBuffer imgData = null;

    /**
     * An array to hold inference results, to be feed into Tensorflow Lite as outputs.
     */
    private float[][] labelProbArray = null;
    /**
     * multi-stage low pass filter
     **/
    private float[][] filterLabelProbArray = null;
    private static final int FILTER_STAGES = 3;
    private static final float FILTER_FACTOR = 0.4f;

    private PriorityQueue<Map.Entry<String, Float>> sortedLabels =
            new PriorityQueue<>(
                    RESULTS_TO_SHOW,
                    new Comparator<Map.Entry<String, Float>>() {
                        @Override
                        public int compare(Map.Entry<String, Float> o1, Map.Entry<String, Float> o2) {
                            return (o1.getValue()).compareTo(o2.getValue());
                        }
                    });

    /**
     * Initializes an {@code ImageClassifier}.
     */
    public ImageClassifier(Activity activity) throws IOException {
        Log.d("DevLogger","ImageClassifier constructor");
        tflite = new Interpreter(loadModelFile(activity));
        Log.d("DevLogger","ImageClassifier constructor 1");

        labelList = loadLabelList(activity);

        Log.d("DevLogger","ImageClassifier constructor 2");

        imgData =
                ByteBuffer.allocateDirect(
                        4 * DIM_BATCH_SIZE * DIM_IMG_SIZE_X * DIM_IMG_SIZE_Y * DIM_PIXEL_SIZE);

        Log.d("DevLogger","ImageClassifier constructor 3");

        imgData.order(ByteOrder.nativeOrder());

        Log.d("DevLogger","ImageClassifier constructor 4");

        labelProbArray = new float[1][labelList.size()];

        Log.d("DevLogger","ImageClassifier constructor 5");

        filterLabelProbArray = new float[FILTER_STAGES][labelList.size()];
        Log.d("DevLogger","ImageClassifier constructor 6");

        Log.d(TAG, "Created a Tensorflow Lite Image Classifier.");
    }

    /**
     * Classifies a frame from the preview stream.
     */
    public Drinks classifyFrame(Bitmap bitmap) {
        if (tflite == null) {
            Log.e(TAG, "Image classifier has not been initialized; Skipped.");
            return null;
        }

        convertBitmapToByteBuffer(bitmap);
        // Here's where the magic happens!!!
        long startTime = SystemClock.uptimeMillis();
        tflite.run(imgData, labelProbArray);
        long endTime = SystemClock.uptimeMillis();
        Log.d(TAG, "Timecost to run model inference: " + Long.toString(endTime - startTime));

        // smooth the results
        applyFilter();

        // print the results
        return printTopKLabels();
    }

    void applyFilter() {
        int num_labels = labelList.size();

        // Low pass filter `labelProbArray` into the first stage of the filter.
        for (int j = 0; j < num_labels; ++j) {
            filterLabelProbArray[0][j] += FILTER_FACTOR * (labelProbArray[0][j] -
                    filterLabelProbArray[0][j]);
        }
        // Low pass filter each stage into the next.
        for (int i = 1; i < FILTER_STAGES; ++i) {
            for (int j = 0; j < num_labels; ++j) {
                filterLabelProbArray[i][j] += FILTER_FACTOR * (
                        filterLabelProbArray[i - 1][j] -
                                filterLabelProbArray[i][j]);

            }
        }

        // Copy the last stage filter output back to `labelProbArray`.
        for (int j = 0; j < num_labels; ++j) {
            labelProbArray[0][j] = filterLabelProbArray[FILTER_STAGES - 1][j];
        }
    }

    /**
     * Closes tflite to release resources.
     */
    public void close() {
        tflite.close();
        tflite = null;
    }

    /**
     * Reads label list from Assets.
     */
    private List<String> loadLabelList(Activity activity) throws IOException {
        List<String> labelList = new ArrayList<String>();
        BufferedReader reader =
                new BufferedReader(new InputStreamReader(activity.getAssets().open(LABEL_PATH)));
        String line;
        while ((line = reader.readLine()) != null) {
            labelList.add(line);
        }
        reader.close();
        return labelList;
    }

    /**
     * Memory-map the model file in Assets.
     */
    private MappedByteBuffer loadModelFile(Activity activity) throws IOException {
        AssetFileDescriptor fileDescriptor = activity.getAssets().openFd(MODEL_PATH);
        FileInputStream inputStream = new FileInputStream(fileDescriptor.getFileDescriptor());
        FileChannel fileChannel = inputStream.getChannel();
        long startOffset = fileDescriptor.getStartOffset();
        long declaredLength = fileDescriptor.getDeclaredLength();
        return fileChannel.map(FileChannel.MapMode.READ_ONLY, startOffset, declaredLength);
    }

    /**
     * Writes Image data into a {@code ByteBuffer}.
     */
    private void convertBitmapToByteBuffer(Bitmap bitmap) {
        if (imgData == null) {
            return;
        }
        imgData.rewind();
        bitmap.getPixels(intValues, 0, bitmap.getWidth(), 0, 0, bitmap.getWidth(), bitmap.getHeight());
        // Convert the image to floating point.
        int pixel = 0;
        long startTime = SystemClock.uptimeMillis();
        for (int i = 0; i < DIM_IMG_SIZE_X; ++i) {
            for (int j = 0; j < DIM_IMG_SIZE_Y; ++j) {
                final int val = intValues[pixel++];
                imgData.putFloat((((val >> 16) & 0xFF) - IMAGE_MEAN) / IMAGE_STD);
                imgData.putFloat((((val >> 8) & 0xFF) - IMAGE_MEAN) / IMAGE_STD);
                imgData.putFloat((((val) & 0xFF) - IMAGE_MEAN) / IMAGE_STD);
            }
        }
        long endTime = SystemClock.uptimeMillis();
        Log.d(TAG, "Timecost to put values into ByteBuffer: " + Long.toString(endTime - startTime));
    }

    /**
     * Prints top-K labels, to be shown in UI as the results.
     */
    private Drinks printTopKLabels() {
        for (int i = 0; i < labelList.size(); ++i) {
            sortedLabels.add(
                    new AbstractMap.SimpleEntry<>(labelList.get(i), labelProbArray[0][i]));
            if (sortedLabels.size() > RESULTS_TO_SHOW) {
                sortedLabels.poll();
            }
        }

        final int size = sortedLabels.size();
        ArrayList<Recognition> results = new ArrayList();

        for (int i = 0; i < size; ++i) {
            Map.Entry<String, Float> label = sortedLabels.poll();
            Log.d("DevLogger","recognition = "+label.getKey()+ ", confidence = "+label.getValue());
            results.add(new Recognition("id", label.getKey(), label.getValue()));
//            textToShow = String.format("\n%s: %4.2f", label.getKey(), label.getValue()) + textToShow;
        }

        boolean hasCoke = false;
        boolean hasPerrier = false;
        boolean hasOther = false;

        Recognition cocacolaRecognition = null;
        Recognition perrierRecognition = null;
        Recognition otherRecognition = null;

        for (Recognition result : results) {
            switch (result.getTitle()) {
                case "cocacola":
                    cocacolaRecognition = result;
                    break;
                case "perrier":
                    perrierRecognition = result;
                    break;

                case "other":
                    otherRecognition = result;
                    break;
            }
        }

        if (otherRecognition != null && otherRecognition.getConfidence() > 0.1) {
            return new Drinks(false, false, true);
        }

        if (cocacolaRecognition != null && perrierRecognition != null
            && perrierRecognition.getConfidence() / cocacolaRecognition.getConfidence() > 0.1) {
            return new Drinks(false, true, false);
        }

        if (cocacolaRecognition != null && cocacolaRecognition.getConfidence() > 0.05) {
            return new Drinks(true, false, false);
        }

        return new Drinks(false, false, true);
    }
}