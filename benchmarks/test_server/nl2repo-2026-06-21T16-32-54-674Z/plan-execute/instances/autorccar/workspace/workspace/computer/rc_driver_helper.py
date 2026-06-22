"""
rc_driver_helper.py - Helper classes for RC car autonomous driving control.

Provides hardware control, distance calculation, and object detection
for the AutoRCCar autonomous remote-controlled car system.
"""

import math
import cv2
import numpy as np
import serial


class RCControl:
    """Control the movement of the RC car through the serial port.

    Maps neural network predictions to hardware control commands
    sent via UART to the Arduino controller.
    """

    def __init__(self, serial_port):
        """Initialize the RC car serial port connection.

        Args:
            serial_port (str): Path to the serial port device,
                               e.g. '/dev/tty.usbmodem1421'.
        """
        self.serial_port = serial.Serial(serial_port, 115200, timeout=1)

    def steer(self, prediction):
        """Send a steering command to the RC car based on NN prediction.

        Args:
            prediction (int): Predicted action label.
                0 = Left turn, 1 = Right turn, 2 = Forward,
                Other = Stop (calls stop() internally).
        """
        if prediction == 2:
            self.serial_port.write(chr(1).encode())
            print("Forward")
        elif prediction == 0:
            self.serial_port.write(chr(7).encode())
            print("Left")
        elif prediction == 1:
            self.serial_port.write(chr(6).encode())
            print("Right")
        else:
            self.stop()

    def stop(self):
        """Send an emergency stop command to the RC car."""
        self.serial_port.write(chr(0).encode())


class DistanceToCamera:
    """Calculate the distance from a detected object to the camera.

    Uses camera intrinsic parameters and triangulation to compute
    real-world distance in centimetres from the image-plane y
    coordinate of the target base.
    """

    def __init__(self):
        """Initialise camera calibration parameters."""
        # camera params (obtained through manual measurement and calibration)
        self.alpha = 8.0 * math.pi / 180    # camera viewing angle (radians)
        self.v0 = 119.865631204             # camera matrix parameter v0
        self.ay = 332.262498472             # camera matrix parameter ay

    def calculate(self, v, h, x_shift, image):
        """Compute and display the distance to a target object.

        Args:
            v (float): Y-coordinate of the target base in the image.
            h (float): Actual height of the target object (cm).
            x_shift (int): X-axis offset for overlay text placement.
            image (np.ndarray): Colour image for distance overlay drawing.

        Returns:
            float: Computed distance in centimetres (positive) or negative
                   if the geometry does not yield a valid distance.
        """
        # compute and return the distance from the target point to the camera
        d = h / math.tan(self.alpha + math.atan((v - self.v0) / self.ay))
        if d > 0:
            cv2.putText(image, "%.1fcm" % d,
                        (image.shape[1] - x_shift, image.shape[0] - 20),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
        return d


class ObjectDetection:
    """Detect stop signs and traffic lights using Haar cascade classifiers.

    Provides real-time object detection and traffic light colour
    identification for autonomous driving decisions.
    """

    def __init__(self):
        """Initialise traffic light status flags."""
        # Traffic light status flags
        self.red_light = False      # Red light detection flag
        self.green_light = False    # Green light detection flag
        self.yellow_light = False   # Yellow light detection flag

    def detect(self, cascade_classifier, gray_image, image):
        """Detect objects using a cascade classifier on a frame.

        Args:
            cascade_classifier: OpenCV CascadeClassifier object.
            gray_image (np.ndarray): Grayscale image for detection.
            image (np.ndarray): Colour image for drawing results.

        Returns:
            int: Y-coordinate of the bottom of the detected object,
                 or 0 if no object is detected.
        """
        v = 0

        # Guard: if the classifier has not been loaded with a valid XML,
        # it is empty and detectMultiScale will throw an assertion error.
        if cascade_classifier.empty():
            return v

        # detection
        cascade_obj = cascade_classifier.detectMultiScale(
            gray_image,
            scaleFactor=1.1,
            minNeighbors=5,
            minSize=(30, 30))

        for (x_pos, y_pos, width, height) in cascade_obj:
            cv2.rectangle(image,
                          (x_pos + 5, y_pos + 5),
                          (x_pos + width - 5, y_pos + height - 5),
                          (255, 255, 255), 2)
            v = y_pos + height - 5

            # stop sign
            if width / height == 1:
                cv2.putText(image, 'STOP', (x_pos, y_pos - 10),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2)

            # traffic lights
            else:
                roi = gray_image[y_pos + 10:y_pos + height - 10,
                                 x_pos + 10:x_pos + width - 10]
                mask = cv2.GaussianBlur(roi, (25, 25), 0)
                (minVal, maxVal, minLoc, maxLoc) = cv2.minMaxLoc(mask)

                # check if light is on
                if maxVal - minVal > 5:
                    cv2.circle(roi, maxLoc, 5, (255, 0, 0), 2)

                    # Red light
                    if (1.0 / 8) * (height - 30) < maxLoc[1] < (4.0 / 8) * (height - 30):
                        cv2.putText(image, 'Red', (x_pos + 5, y_pos - 5),
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.5,
                                    (0, 0, 255), 2)
                        self.red_light = True

                    # Green light
                    elif (5.5 / 8) * (height - 30) < maxLoc[1] < height - 30:
                        cv2.putText(image, 'Green', (x_pos + 5, y_pos - 10),
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.5,
                                    (0, 255, 0), 2)
                        self.green_light = True

        return v
