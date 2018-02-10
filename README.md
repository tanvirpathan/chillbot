# Chillbot

Chillbot is a google home based application that uses tensorflow and machine learning to determine which kinds of drinks are available in a fridge.


## How does it work?

### Components
1. [Google Home](https://store.google.com/product/google_home)
2. [Pico Pro Maker Kit](https://developer.android.com/things/hardware/imx7d-kit.html)

### How it was made
1. First step of the project was to take as many pictures of a few types of drinks (Coke/Perrier/Diet-Coke) in various orientation and lighting conditions. 
2. The purpose of these images were to be used with tensorflow to help classify images that will be taken when the user queries the google home for information.
3. Using the camera module from the maker kit, we could take a picture inside the fridge and process the image to determine what drinks are available.
4. This information is then stored to a firebase database as a simple json containing boolean values for the type of drinks we chose demo with. 
5. The google home was used to create a few simple actions that the user could use to determine if the type of drink they were looking for was in the fridge. 


