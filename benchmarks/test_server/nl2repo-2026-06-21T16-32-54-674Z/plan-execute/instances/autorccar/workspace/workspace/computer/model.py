"""
AutoRCCar - Neural Network Model Module

Implements a neural network model based on OpenCV's MLP for autonomous
driving decision prediction. Supports image data collection, model
training, prediction verification, and model persistence.

The model architecture is a fully connected network of 76800->32->4,
using the Sigmoid activation function and back-propagation training.
"""

import os
import glob
import numpy as np
import cv2
from typing import Tuple


def load_data(input_size: int, path: str) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    Load training data from a specified path, perform data preprocessing,
    and split the data into training and validation sets.

    Parameters:
        input_size (int): The size of the input image (number of pixels).
        path (str): The path to the training data file, supporting glob
                    pattern matching (e.g., "training_data/*.npz").

    Returns:
        A tuple containing the training set and validation set:
            (X_train, X_test, y_train, y_test)

        - X_train (np.ndarray): Training feature data, shape (n_train_samples, input_size)
        - X_test  (np.ndarray): Validation feature data, shape (n_test_samples, input_size)
        - y_train (np.ndarray): Training label data, shape (n_train_samples, 4)
        - y_test  (np.ndarray): Validation label data, shape (n_test_samples, 4)
    """
    # Find all matching npz files using glob pattern
    files = glob.glob(path)

    if not files:
        raise FileNotFoundError(f"No training data files found matching pattern: {path}")

    all_X = []
    all_y = []

    for file_path in files:
        try:
            data = np.load(file_path)

            # Extract features and labels from the npz file
            # Expected keys: 'image' (flattened image data) and 'label' (one-hot encoded label)
            X = data['image']
            y = data['label']

            # Ensure the image data is flattened to the correct input size
            if X.ndim == 1:
                X = X.reshape(1, -1)

            # Resize/reshape to match expected input_size if necessary
            if X.shape[1] != input_size:
                X = X.reshape(X.shape[0], -1)
                # Pad or truncate to match input_size
                if X.shape[1] > input_size:
                    X = X[:, :input_size]
                elif X.shape[1] < input_size:
                    padding = np.zeros((X.shape[0], input_size - X.shape[1]))
                    X = np.hstack([X, padding])

            # Ensure labels are one-hot encoded (4 classes: left, right, forward, stop)
            if y.ndim == 1:
                y_one_hot = np.zeros((len(y), 4), dtype=np.float32)
                for i, label in enumerate(y):
                    if 0 <= int(label) < 4:
                        y_one_hot[i, int(label)] = 1.0
                y = y_one_hot
            elif y.shape[1] != 4:
                # Convert to 4-class one-hot if different shape
                y_one_hot = np.zeros((y.shape[0], 4), dtype=np.float32)
                max_labels = np.argmax(y, axis=1)
                for i, label in enumerate(max_labels):
                    if 0 <= label < 4:
                        y_one_hot[i, label] = 1.0
                y = y_one_hot

            all_X.append(X)
            all_y.append(y)

        except (KeyError, ValueError, IndexError) as e:
            print(f"Warning: Skipping file {file_path} due to error: {e}")
            continue

    if not all_X:
        raise ValueError("No valid training data could be loaded from the specified files.")

    # Concatenate all data
    X_all = np.vstack(all_X).astype(np.float32)
    y_all = np.vstack(all_y).astype(np.float32)

    # Normalize feature data to [0, 1] range
    X_all = X_all / 255.0

    # Shuffle the data
    indices = np.arange(X_all.shape[0])
    np.random.shuffle(indices)
    X_all = X_all[indices]
    y_all = y_all[indices]

    # Split into training (80%) and validation (20%) sets
    split_idx = int(0.8 * len(X_all))

    X_train = X_all[:split_idx]
    X_test = X_all[split_idx:]
    y_train = y_all[:split_idx]
    y_test = y_all[split_idx:]

    print(f"Loaded {len(files)} file(s), {len(X_all)} total samples")
    print(f"Training set: {X_train.shape[0]} samples, Validation set: {X_test.shape[0]} samples")
    print(f"Feature shape: {X_train.shape[1]}, Label shape: {y_train.shape[1]}")

    return X_train, X_test, y_train, y_test


class NeuralNetwork:
    """
    A neural network model based on OpenCV's MLP for autonomous driving
    decision prediction.

    The model architecture is a fully connected network: 76800 -> 32 -> 4,
    using the Sigmoid activation function and back-propagation training.

    Class labels:
        0: Left turn
        1: Right turn
        2: Forward
        3: Stop
    """

    def __init__(self):
        """
        Initialize the NeuralNetwork instance.

        Sets the internal MLP model reference to None. Call create()
        before using train(), predict(), evaluate(), or save_model().
        """
        self.mlpc = None

    def create(self, layer_sizes: np.ndarray) -> None:
        """
        Create a neural network with the specified layer architecture.

        Parameters:
            layer_sizes (np.ndarray): The number of nodes in each layer of
                                      the neural network, e.g., [76800, 32, 4].
        """
        if not isinstance(layer_sizes, np.ndarray):
            layer_sizes = np.array(layer_sizes, dtype=np.int32)

        # Create the MLP model
        self.mlpc = cv2.ml.ANN_MLP_create()

        # Set layer sizes
        self.mlpc.setLayerSizes(layer_sizes)

        # Configure the training method: BACKPROP with learning rate=0.001, momentum=0.1
        # param1 = backpropWeightScale (learning rate), param2 = backpropMomentumScale
        self.mlpc.setTrainMethod(cv2.ml.ANN_MLP_BACKPROP, param1=0.001, param2=0.1)

        # Set Sigmoid activation function (symmetric, slope=1.0, asymmetric coefficient=1.0)
        self.mlpc.setActivationFunction(cv2.ml.ANN_MLP_SIGMOID_SYM, param1=1.0, param2=1.0)

        # Set the number of iterations and termination criteria
        self.mlpc.setTermCriteria((cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 100, 1e-6))

    def train(self, X: np.ndarray, y: np.ndarray) -> None:
        """
        Train the neural network model using the provided data.

        Parameters:
            X (np.ndarray): Training feature data, shape (n_samples, n_features).
            y (np.ndarray): Training label data (one-hot encoded), shape (n_samples, n_classes).
        """
        if self.mlpc is None:
            raise RuntimeError("Neural network not created. Call create() first.")

        if X.dtype != np.float32:
            X = X.astype(np.float32)
        if y.dtype != np.float32:
            y = y.astype(np.float32)

        # Train the model
        self.mlpc.train(X, cv2.ml.ROW_SAMPLE, y)

    def evaluate(self, X: np.ndarray, y: np.ndarray) -> float:
        """
        Evaluate the model accuracy on the provided data.

        Parameters:
            X (np.ndarray): Test feature data.
            y (np.ndarray): Test label data (one-hot encoded).

        Returns:
            float: The model accuracy (a value between 0 and 1).
        """
        if self.mlpc is None:
            raise RuntimeError("Neural network not created or not loaded.")

        if X.dtype != np.float32:
            X = X.astype(np.float32)
        if y.dtype != np.float32:
            y = y.astype(np.float32)

        # Get predictions
        _, predictions = self.mlpc.predict(X)

        # Calculate accuracy by comparing argmax of predictions and labels
        predicted_labels = np.argmax(predictions, axis=1)
        true_labels = np.argmax(y, axis=1)

        accuracy = np.mean(predicted_labels == true_labels)

        return float(accuracy)

    def predict(self, X: np.ndarray) -> np.ndarray:
        """
        Make predictions using the trained model.

        Parameters:
            X (np.ndarray): Feature data to be predicted.

        Returns:
            np.ndarray: Array of predicted class labels.
                        0: Left turn, 1: Right turn, 2: Forward, 3: Stop
        """
        if self.mlpc is None:
            raise RuntimeError("Neural network not created or not loaded.")

        if X.dtype != np.float32:
            X = X.astype(np.float32)

        # Ensure input is 2D
        if X.ndim == 1:
            X = X.reshape(1, -1)

        # Get predictions
        _, result = self.mlpc.predict(X)

        # Return the predicted class labels
        predictions = np.argmax(result, axis=1)

        return predictions

    def save_model(self, path: str) -> None:
        """
        Save the trained model to a file.

        Parameters:
            path (str): The path to save the model file.
        """
        if self.mlpc is None:
            raise RuntimeError("Neural network not created. Nothing to save.")

        # Create directory if it doesn't exist
        directory = os.path.dirname(path)
        if directory:
            os.makedirs(directory, exist_ok=True)

        self.mlpc.save(path)
        print(f"Model saved to: {path}")

    def load_model(self, path: str) -> None:
        """
        Load a trained model from a file.

        Parameters:
            path (str): The path to the model file.
        """
        if not os.path.exists(path):
            raise FileNotFoundError(f"Model file not found: {path}")

        self.mlpc = cv2.ml.ANN_MLP_load(path)
        print(f"Model loaded from: {path}")
